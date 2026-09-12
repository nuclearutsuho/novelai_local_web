import { useCallback, useEffect, useRef, useState } from 'react';
import { generateImage } from './ImageGenerationService';
import batchController from '../tools/BatchGeneration/BatchGenerationService';
import apiClient from '@/utils/ApiClient';
import { runStudioBatch } from '@/utils/StudioBatchFlow.mjs';
import { currentStorageScope } from '@/utils/userStorage.mjs';
import { revokeObjectUrl } from '@/utils/mediaAssets';
import {
  createGenerationError,
  GENERATION_ERROR_CODES,
  normalizeGenerationErrorCode,
} from './errors';

const createIdleStatus = () => ({
  status: 'idle',
  queuePosition: null,
  progress: 0,
  error: null,
  errorCode: null,
  errorId: null,
  category: null,
  statusCode: null,
  model: null,
  terminalGenerationFailed: false,
});

const useImageGeneration = () => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState(createIdleStatus);
  const [batchStatus, setBatchStatus] = useState(batchController.getStatus());
  const generatingRef = useRef(0);
  const batchIdRef = useRef('');
  const batchOwnerRef = useRef('');
  const mountedRef = useRef(false);

  const startGeneration = useCallback(async (params) => {
    const owner = currentStorageScope();
    const isCurrent = () => mountedRef.current && currentStorageScope() === owner;
    const checkOwner = () => { if (!isCurrent()) throw Object.assign(new Error('STUDIO_IDENTITY_CHANGED'), { code: 'STUDIO_IDENTITY_CHANGED' }); };
    if (!isCurrent()) return null;
    if (generatingRef.current && !apiClient.studioTasks.isBatch(params.batch_id)) return null;
    generatingRef.current += 1;
    setIsGenerating(true);
    setGenerationStatus({
      ...createIdleStatus(),
      status: 'processing',
      progress: 10,
      model: params.model || null,
    });

    try {
      const result = await generateImage(params, (progress) => {
        if (isCurrent()) setGenerationStatus((previous) => ({ ...previous, ...progress }));
      }, checkOwner);
      if (!isCurrent()) { revokeObjectUrl(result.objectUrlToRevoke); return null; }
      if (!result.success) {
        throw createGenerationError(
          normalizeGenerationErrorCode(result, GENERATION_ERROR_CODES.GENERATION_FAILED),
          {
            category: result.category,
            statusCode: result.statusCode,
            errorId: result.errorId,
            model: result.model || params.model,
          },
        );
      }

      setGenerationStatus({
        ...createIdleStatus(),
        status: 'completed',
        progress: 100,
        model: result.model || params.model || null,
      });
      return {
        id: `${Date.now()}-${params.index ?? 0}`,
        studioRequestId: result.studioRequestId || null,
        studioDirectorReceipt: result.studioDirectorReceipt || null,
        src: result.imageUrl || result.image,
        originalSrc: result.downloadUrl || result.imageUrl || result.image,
        downloadSrc: result.downloadUrl || result.imageUrl || result.image,
        cachedBlob: result.cachedBlob || null,
        objectUrlToRevoke: result.objectUrlToRevoke || null,
        seed: result.seed ?? params.seed ?? '',
        prompt: params.positivePrompt || '',
        width: result.width,
        height: result.height,
        isComposited: false,
        model: result.model || params.model || null,
      };
    } catch (error) {
      if (!isCurrent()) return null;
      const normalizedError = createGenerationError(
        normalizeGenerationErrorCode(error, GENERATION_ERROR_CODES.GENERATION_FAILED),
        {
          category: error?.category,
          statusCode: error?.statusCode,
          errorId: error?.errorId,
          model: error?.model || params.model,
        },
      );
      setGenerationStatus({
        ...createIdleStatus(),
        status: 'failed',
        errorCode: normalizedError.code,
        errorId: normalizedError.errorId || null,
        category: normalizedError.category || null,
        statusCode: normalizedError.statusCode || null,
        model: normalizedError.model || params.model || null,
      });
      throw normalizedError;
    } finally {
      generatingRef.current -= 1;
      if (isCurrent() && generatingRef.current === 0) setIsGenerating(false);
    }
  }, []);

  const startBatchGeneration = useCallback(async (params, onImageGenerated, onBatchError) => {
    if (batchIdRef.current || generatingRef.current) throw Object.assign(new Error('已有生成正在进行'), { code: 'STUDIO_TASK_PENDING' });
    const owner = currentStorageScope();
    batchOwnerRef.current = owner;
    const batchSize = Math.min(apiClient.isStudio() ? 64 : 16, Math.max(1, Number.parseInt(params.batchSize, 10) || 1));
    const batchId = crypto.randomUUID();
    batchIdRef.current = batchId;
    if (apiClient.isStudio() && !params.imageToImage?.directorTools?.active) {
      try {
        return await runStudioBatch({ runner: apiClient.studioTasks, batchId, count: batchSize,
          paramsFor: () => ({ ...params, seed: crypto.getRandomValues(new Uint32Array(1))[0] }),
          generate: startGeneration, receive: onImageGenerated,
          onError: onBatchError, onStatus: setBatchStatus,
          isCurrent: () => mountedRef.current && currentStorageScope() === owner,
          release: item => revokeObjectUrl(item.objectUrlToRevoke),
        });
      } finally { if (batchIdRef.current === batchId) batchIdRef.current = ''; }
    }
    batchController.initialize(batchSize);
    batchController.setParams(params);
    setBatchStatus({ ...batchController.getStatus() });

    while (batchController.shouldContinue()) {
      if (!mountedRef.current) break;
      if (currentStorageScope() !== owner) {
        batchController.cancel();
        break;
      }
      const imageIndex = batchController.status.current - 1;
      try {
        const imageResult = await startGeneration({
          ...batchController.getParams(),
          batch_id: batchId,
          index: imageIndex,
          batch_size: batchSize,
        });
        if (!mountedRef.current || currentStorageScope() !== owner) {
          revokeObjectUrl(imageResult?.objectUrlToRevoke);
          break;
        }
        if (!imageResult) throw createGenerationError(GENERATION_ERROR_CODES.GENERATION_FAILED);

        batchController.completeCurrentImage(true);
        setBatchStatus({ ...batchController.getStatus() });
        if (typeof onImageGenerated === 'function') onImageGenerated(imageResult);

      } catch (error) {
        if (!mountedRef.current || currentStorageScope() !== owner) break;
        batchController.completeCurrentImage(false);
        batchController.handleError(error, (errorDetails) => {
          if (typeof onBatchError === 'function') {
            onBatchError(errorDetails, imageIndex + 1, batchSize);
          }
        });
        setBatchStatus({ ...batchController.getStatus() });
        // 旧批次只能收尾自己的会话，切换账号后不能取消新用户的任务。
        if (currentStorageScope() === owner) await apiClient.cancelImageBatch(batchId).catch(() => {});
        break;
      }
    }

    batchIdRef.current = '';
    return batchController.getStatus();
  }, [startGeneration]);

  const stopBatchGeneration = useCallback((updateUi, keepalive = false) => {
    const batchId = batchIdRef.current;
    if (apiClient.isStudio() && apiClient.studioTasks.isBatch(batchId)) {
      // 取消请求已发出后仍等待所有在途任务收尾；关页保留服务器任务供恢复。
      if (!keepalive && currentStorageScope() === batchOwnerRef.current) {
        void apiClient.cancelImageBatch(batchId).catch(() => {});
      }
      return;
    }
    batchController.cancel();
    batchIdRef.current = '';
    if (updateUi) setBatchStatus({ ...batchController.getStatus() });
    if (batchId && currentStorageScope() === batchOwnerRef.current) {
      void apiClient.cancelImageBatch(batchId, keepalive).catch(() => {});
    }
  }, []);

  const cancelBatchGeneration = useCallback(() => {
    stopBatchGeneration(true);
  }, [stopBatchGeneration]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 页面关闭、路由切换或退出登录时，只拦截尚未发送的后续请求。
      stopBatchGeneration(false, true);
    };
  }, [stopBatchGeneration]);

  const resetGeneration = useCallback(() => setGenerationStatus(createIdleStatus()), []);

  return {
    isGenerating,
    generationStatus,
    startGeneration,
    resetGeneration,
    setIsGenerating,
    setGenerationStatus,
    batchStatus,
    startBatchGeneration,
    cancelBatchGeneration,
  };
};

export default useImageGeneration;
