import type { PageServerLoad } from "./$types";
import { marked } from "marked";
import privacyMarkdown from "../../../docs/privacy.md?raw";

const html = marked.parse(privacyMarkdown, { async: false }) as string;

export const load: PageServerLoad = async () => ({ html });
