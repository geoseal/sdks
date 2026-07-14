// Client-side mirror of the platform's public-id codec. The platform encodes a
// subject's public id as `sub_` + uuid-without-dashes
// (supabase/functions/_shared/ids.ts), and the SDK fence/ingest endpoints key on
// that public id / the subject's external_id. Pure + dependency-free.

export type LocationPermission = "unknown" | "denied" | "while_using" | "always";

// Encode/decode the subject public id (mirror of _shared/ids.ts).
export function encodeSubjectPublicId(uuid: string): string {
  return "sub_" + uuid.replace(/-/g, "");
}

export function decodeSubjectPublicId(publicId: string): string | null {
  if (!publicId.startsWith("sub_")) return null;
  const hex = publicId.slice(4);
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  return (
    hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
    hex.slice(16, 20) + "-" + hex.slice(20)
  ).toLowerCase();
}
