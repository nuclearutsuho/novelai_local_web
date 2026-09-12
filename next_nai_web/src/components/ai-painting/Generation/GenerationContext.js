import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import useImageGeneration from './useImageGeneration';
import { revokeObjectUrl } from '@/utils/mediaAssets';
import StudioTaskRecovery from './StudioTaskRecovery';
import StudioToolRecovery from './StudioToolRecovery';
import apiClient from '@/utils/ApiClient';
import { currentStorageScope } from '@/utils/userStorage.mjs';
import { publishGeneratedItem } from '@/utils/imageOperationLifecycle.mjs';

const GenerationContext = createContext();

const revokeGeneratedItemUrls = (item) => {
  if (!item) return;
  new Set([
    item.objectUrlToRevoke,
    item.src,
    item.originalSrc,
    item.downloadSrc,
  ].filter(Boolean)).forEach(revokeObjectUrl);
};

export const GenerationProvider = ({ children }) => {
  const {
    isGenerating,
    generationStatus,
    startGeneration,
    resetGeneration,
    batchStatus,
    startBatchGeneration,
    cancelBatchGeneration,
  } = useImageGeneration();
  const [generatedItems, setGeneratedItems] = useState([]);
  const [currentItem, setCurrentItem] = useState(null);
  const generatedItemsRef = useRef([]);
  const workspaceRecoveryRef = useRef(null);
  const mountedRef = useRef(false);
  const ownerRef = useRef(currentStorageScope());
  const registerWorkspaceRecovery = useCallback((handler) => {
    workspaceRecoveryRef.current = handler;
    return () => { if (workspaceRecoveryRef.current === handler) workspaceRecoveryRef.current = null; };
  }, []);

  useEffect(() => {
    generatedItemsRef.current = generatedItems;
  }, [generatedItems]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generatedItemsRef.current.forEach(revokeGeneratedItemUrls);
    };
  }, []);

  const appendGeneratedItem = useCallback((item) => {
    if (!item) return null;
    const normalizedItem = {
      type: 'image',
      ...item,
      id: item.id || `image-${Date.now()}-${Math.random()}`,
    };
    return publishGeneratedItem({ item: normalizedItem,
      isCurrent: () => mountedRef.current && currentStorageScope() === ownerRef.current,
      release: revokeGeneratedItemUrls,
      append: accepted => {
        setGeneratedItems(previous => [...previous, accepted]);
        setCurrentItem(accepted);
      },
      acknowledge: accepted => {
        if (accepted.studioRequestId) apiClient.studioTasks.acknowledge(accepted.studioRequestId);
        if (accepted.studioDirectorReceipt) apiClient.studioDirectors.acknowledge(accepted.studioDirectorReceipt);
      },
    });
  }, []);

  const recoverItem = useCallback(async (item, workspace, checkOwner) => {
    checkOwner();
    if (workspace) {
      if (!workspaceRecoveryRef.current) throw new Error('STUDIO_WORKSPACE_NOT_MOUNTED');
      await workspaceRecoveryRef.current(item, workspace, checkOwner);
    } else appendGeneratedItem(item);
  }, [appendGeneratedItem]);

  const updateGeneratedItem = useCallback((itemId, updates) => {
    if (!itemId || !updates) return;
    setGeneratedItems((previous) => previous.map((item) => (
      item.id === itemId ? { ...item, ...updates } : item
    )));
    setCurrentItem((previous) => (
      previous?.id === itemId ? { ...previous, ...updates } : previous
    ));
  }, []);

  const generate = useCallback(async (params) => {
    resetGeneration();
    const imageResult = await startGeneration(params);
    return imageResult ? appendGeneratedItem({ ...imageResult, type: 'image' }) : null;
  }, [appendGeneratedItem, resetGeneration, startGeneration]);

  const generatePreview = useCallback(async (params) => {
    resetGeneration();
    // 预览要等原版画布完成图片加载和蒙版处理后，才能确认领取 Studio 结果。
    const imageResult = await startGeneration({ ...params, studioDeferAcknowledgement: true });
    return imageResult ? { ...imageResult, type: 'image' } : null;
  }, [resetGeneration, startGeneration]);

  const generateBatchImages = useCallback(async (params, onImageCallback, onErrorNotify) => {
    resetGeneration();
    return startBatchGeneration(
      params,
      (newImage) => {
        const newItem = appendGeneratedItem({ ...newImage, type: 'image' });
        if (typeof onImageCallback === 'function') onImageCallback(newItem);
      },
      onErrorNotify,
    );
  }, [appendGeneratedItem, resetGeneration, startBatchGeneration]);

  const selectItem = useCallback((itemId) => {
    const selected = generatedItems.find((item) => item.id === itemId);
    if (selected) setCurrentItem(selected);
  }, [generatedItems]);

  const deleteItem = useCallback((itemId) => {
    setGeneratedItems((previous) => {
      const itemToDelete = previous.find((item) => item.id === itemId);
      const remaining = previous.filter((item) => item.id !== itemId);
      revokeGeneratedItemUrls(itemToDelete);
      if (currentItem?.id === itemId) setCurrentItem(remaining.at(-1) || null);
      return remaining;
    });
  }, [currentItem]);

  const contextValue = {
    isGenerating,
    generationStatus,
    generatedItems,
    currentItem,
    batchStatus,
    generate,
    generatePreview,
    registerWorkspaceRecovery,
    appendGeneratedItem,
    updateGeneratedItem,
    resetGeneration,
    selectItem,
    deleteItem,
    generateBatchImages,
    cancelBatchGeneration,
  };

  return (
    <GenerationContext.Provider value={contextValue}>
      <StudioTaskRecovery onRecovered={recoverItem} />
      <StudioToolRecovery />
      {children}
    </GenerationContext.Provider>
  );
};

export const useGeneration = () => {
  const context = useContext(GenerationContext);
  if (!context) throw new Error('useGeneration must be used within GenerationProvider');
  return context;
};
