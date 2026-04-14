import type { SupabaseClient } from "@supabase/supabase-js";
import { hashToken } from "./tokens";

export interface AuthenticatedDevice {
  id: string;
  userId: string;
  hardwareId: string;
  name: string;
}

type AuthResult =
  | { device: AuthenticatedDevice }
  | { error: "missing_token" | "invalid_token" | "token_revoked" };

export async function authenticateDevice(
  request: Request,
  supabase: SupabaseClient,
): Promise<AuthResult> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "missing_token" };
  }

  const token = authHeader.slice(7);
  if (!token.startsWith("sk_device_")) {
    return { error: "invalid_token" };
  }

  const tokenHash = hashToken(token);

  const { data: device, error } = await supabase
    .from("devices")
    .select("id, user_id, hardware_id, name, revoked_at")
    .eq("api_token_hash", tokenHash)
    .single();

  if (error || !device) {
    return { error: "invalid_token" };
  }

  if (device.revoked_at) {
    return { error: "token_revoked" };
  }

  return {
    device: {
      id: device.id,
      userId: device.user_id,
      hardwareId: device.hardware_id,
      name: device.name,
    },
  };
}
