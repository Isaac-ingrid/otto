// No task text, links or credentials are ever carried in a notification. Opening it returns
// to the ordinary authenticated workspace, which remains authoritative for pending decisions.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let message = {};
    try { message = event.data?.json() ?? {}; } catch { /* generic wake-up */ }
    const attention = message.kind === 'attention';
    await self.registration.showNotification('Otto', {
      body: message.kind === 'test' ? 'Test notification · 测试通知已送达' :
        message.kind === 'health' ? 'Health check update · 自检状态有更新' :
        attention ? 'A decision needs you · 有待处理事项' : 'A task has finished · 有任务已完成',
      tag: typeof message.tag === 'string' && message.tag.length < 256 ? message.tag : 'otto-update',
      icon: '/brand/otto-avatar.png',
      data: { url: '/app' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname.startsWith('/app'));
    if (existing) return existing.focus();
    return self.clients.openWindow('/app/');
  })());
});
