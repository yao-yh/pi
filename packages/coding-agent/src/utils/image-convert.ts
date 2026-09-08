import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		// Photon 不可用，无法转换
		return null;
	}

	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		// 转换失败
		return null;
	}
}

/**
 * 将图像转换为 PNG 格式，以供终端显示。
 * Kitty 图形协议要求使用 PNG 格式（f=100）。
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// 已是 PNG，无需转换
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}
