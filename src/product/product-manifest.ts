// 产品身份必须与 Microsoft 的 Visual Studio Code 发行版明确区分。
export interface ProductManifest {
  readonly productName: string;
  readonly applicationName: string;
  readonly dataFolderName: string;
  readonly protocolScheme: string;
  readonly settingsNamespace: string;
  readonly telemetryEnabled: false;
  readonly microsoftExtensionGalleryEnabled: false;
}

export const PRODUCT_MANIFEST: ProductManifest = {
  productName: "Independent AI IDE",
  applicationName: "independent-ai-ide",
  dataFolderName: ".independent-ai-ide",
  protocolScheme: "independent-ai-ide",
  settingsNamespace: "independentAiIde",
  telemetryEnabled: false,
  microsoftExtensionGalleryEnabled: false,
};

// 公开发行前必须通过品牌校验，避免误用 Microsoft 产品身份。
export function validateProductManifest(manifest: ProductManifest): void {
  const combinedIdentity = [
    manifest.productName,
    manifest.applicationName,
    manifest.dataFolderName,
    manifest.protocolScheme,
  ].join(" ").toLowerCase();

  if (combinedIdentity.includes("visual studio code") || combinedIdentity.includes("vscode")) {
    throw new Error("独立产品身份不能使用 Visual Studio Code 或 VS Code 品牌");
  }
  if (manifest.telemetryEnabled) {
    throw new Error("Phase 1 禁止启用遥测");
  }
  if (manifest.microsoftExtensionGalleryEnabled) {
    throw new Error("Phase 1 禁止启用 Microsoft 扩展市场配置");
  }
}
