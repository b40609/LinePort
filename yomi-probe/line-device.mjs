// Device identity is process-wide: Yomi's shared transport reads LINE_APP_CONFIG.
// Apply before importing login modules, which snapshot some defaults on import.
// These are LINE protocol identities, not host OS or primary-device requirements.
const profiles = Object.freeze({
  DESKTOPMAC: Object.freeze({ id: 'DESKTOPMAC', label: 'Mac 桌面模式', directory: 'LineCallYomiProbe', notice: '使用 LINE 桌面登入身分，主機不需是 Mac。登入可能使官方電腦版 LINE 登出。' }),
  IOSIPAD: Object.freeze({ id: 'IOSIPAD', label: 'iPad 實驗模式', directory: 'LineCallYomiProbe-IOSIPAD', notice: '使用 LINE iPad 登入身分，無需實體 iPad，也不限定 iPhone。首次請以主要裝置的 LINE 掃碼授權，資料獨立保存。單一帳號已確認與官方電腦版同時登入且收發正常；其他裝置組合、本模式的訊息解密與轉送仍待驗證。' }),
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
