import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({
  locals: { safeGetSession, locale },
  cookies,
}) => {
  const { session, user } = await safeGetSession();
  return { session, user, locale, cookies: cookies.getAll() };
};
