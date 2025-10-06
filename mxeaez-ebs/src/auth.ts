// src/auth.ts
import jwt from "jsonwebtoken";

const SECRET = Buffer.from(process.env.EXT_SECRET!, "base64");

export type TwitchClaims = {
  channel_id: string;
  opaque_user_id: string;
  user_id?: string;
  role: "viewer" | "broadcaster" | "moderator";
};

export function verifyTwitchToken(bearer?: string): TwitchClaims {
  if (!bearer?.startsWith("Bearer ")) throw new Error("Missing bearer");
  const token = bearer.slice(7);
  const decoded = jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as any;
  if (!decoded?.channel_id || !decoded?.opaque_user_id) {
    throw new Error("Bad claims");
  }
  return decoded as TwitchClaims;
}
