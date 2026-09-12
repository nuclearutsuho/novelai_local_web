// 持久缓存中的“转换中”不代表新页面还有活动请求；恢复只更新界面，不发送网络请求。
export function restoreVibePanel(items, studio) {
  return items.map(item => ({ ...item,
    isTemporarilyDisabled: item.isTemporarilyDisabled === true,
    ...(item.status === 'converting' || item.status === 'interrupted'
      ? { status: 'interrupted', recoveryMode: studio ? 'studio' : 'direct', encodingInfo: item.encodingInfo || {} } : {}),
  }));
}
