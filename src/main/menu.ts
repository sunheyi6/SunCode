import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { WindowManager } from './window-manager';

export function createMenu(windowManager: WindowManager): void {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // macOS app menu
    ...(isMac
      ? [
          {
            label: 'SunCode',
            submenu: [
              { role: 'about' as const, label: '关于 SunCode' },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 SunCode' },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 SunCode' },
            ],
          },
        ]
      : []),

    // 文件
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:newSession');
          },
        },
        {
          label: '打开项目...',
          accelerator: 'CmdOrCtrl+O',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:openProject');
          },
        },
        { type: 'separator' },
        {
          label: '导出会话...',
          accelerator: 'CmdOrCtrl+S',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:exportSession');
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },

    // 编辑
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },

    // 视图
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },

    // 代理
    {
      label: '智能体',
      submenu: [
        {
          label: '中止运行',
          accelerator: 'Escape',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:abort');
          },
        },
        {
          label: '压缩上下文',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:compact');
          },
        },
        { type: 'separator' },
        {
          label: '设置...',
          accelerator: 'CmdOrCtrl+,',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:openSettings');
          },
        },
      ],
    },

    // 帮助
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 SunCode',
          click: (): void => {
            const win = windowManager.getMainWindow();
            win?.webContents.send('menu:about');
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
