// Device identity is process-wide: Yomi's shared transport reads LINE_APP_CONFIG.
// Apply before importing login modules, which snapshot some defaults on import.
const profiles = Object.freeze({
  DESKTOPMAC: Object.freeze({ id: 'DESKTOPMAC', label: 'Mac 桌面模式', directory: 'LineCallYomiProbe', notice: '登入可能使官方電腦版 LINE 登出。' }),
  IOSIPAD: Object.freeze({ id: 'IOSIPAD', label: 'iPad 實驗模式', directory: 'LineCallYomiProbe-IOSIPAD', notice: '已於單一帳號確認兩邊可同時登入，官方電腦版收發正常；本模式的訊息解密與轉送仍待驗證。此模式使用獨立資料，首次需手機掃碼授權。' }),
});

export function lineDevice(value = process.env.LINEPORT_LINE_DEVICE || 'DESKTOPMAC') {
  if (!Object.hasOwn(profiles, value)) throw new Error('Unsupported LINEPORT_LINE_DEVICE; use DESKTOPMAC or IOSIPAD');
  return profiles[value];
}

let activeDevice;
export async function configureLineDevice(id = lineDevice().id) {
  const profile = lineDevice(id);
  if (activeDevice && activeDevice !== id) throw new Error('Restart the process before changing LINE device');
  activeDevice = id;
  const { LINE_APP_CONFIG } = await import('./node_modules/@rikaidev/yomi/dist/line/core/config.js');
  if (id === 'IOSIPAD') {
    // Profile from evex-dev/linejs devices.ts, commit 4fc512ab8c19a2490ca73bb71777beb775ca3ae3.
    // This changes client identification, not Yomi's passwordless/E2EE protocol implementation.
    Object.assign(LINE_APP_CONFIG, {
      lineApp: 'IOSIPAD\t26.7.2\tiOS\t18.0',
      userAgent: 'Line/26.7.2',
      systemName: 'LinePort iPad experiment',
      modelName: 'iPad',
    });
  }
  process.env.LINEPORT_LINE_DEVICE = id;
  return profile;
}
