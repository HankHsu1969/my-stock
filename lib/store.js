// chrome.storage.local 包裝；在一般網頁開啟時（開發預覽）改用 localStorage

const area = globalThis.chrome?.storage?.local;

export async function load(keys) {
  if (area) return area.get(keys);
  const out = {};
  for (const k of keys) {
    const raw = localStorage.getItem(k);
    if (raw != null) out[k] = JSON.parse(raw);
  }
  return out;
}

export async function save(obj) {
  if (area) return area.set(obj);
  for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v));
}

// 彈出視窗與分頁同時開啟時，讓兩邊的清單保持同步
export function onChange(cb) {
  globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'local') cb(changes);
  });
}
