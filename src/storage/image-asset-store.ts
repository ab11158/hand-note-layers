import { App, normalizePath } from "obsidian";

const IMAGE_ASSET_ROOT = ".hand-note-layers/assets";

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) {
      try {
        await app.vault.adapter.mkdir(current);
      } catch (error) {
        if (!(await app.vault.adapter.exists(current))) {
          throw error;
        }
      }
    }
  }
}

export function imageAssetPath(imageId: string, variant: "source" | "result"): string {
  return normalizePath(`${IMAGE_ASSET_ROOT}/${imageId}-${variant}.png`);
}

export async function writeImageAsset(
  app: App,
  imageId: string,
  variant: "source" | "result",
  data: ArrayBuffer
): Promise<string> {
  await ensureFolder(app, IMAGE_ASSET_ROOT);
  const path = imageAssetPath(imageId, variant);
  await app.vault.adapter.writeBinary(path, data);
  return path;
}

export async function readImageAsset(app: App, path: string): Promise<ArrayBuffer> {
  return app.vault.adapter.readBinary(normalizePath(path));
}
