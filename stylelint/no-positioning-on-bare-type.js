import stylelint from "stylelint";
import parser from "postcss-selector-parser";

const { createPlugin, utils } = stylelint;

const ruleName = "librito/no-positioning-on-bare-type";
const messages = utils.ruleMessages(ruleName, {
  rejected: (prop, selector) =>
    `Unexpected layout/positioning property "${prop}" on bare type selector "${selector}". Move it to a class or component-scoped style (issue #472).`,
});
const meta = {
  url: "https://github.com/librito-io/web/blob/main/docs/dev/style-guide.md",
};

// Layout/positioning properties. A leak of any of these onto a reused
// semantic element is structural (stacking, scroll), not cosmetic — unlike
// typography (#421), which is deliberately allowed on bare tags.
const POSITIONING_PROPS = new Set([
  "position",
  "z-index",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "inset-block",
  "inset-inline",
  "inset-block-start",
  "inset-block-end",
  "inset-inline-start",
  "inset-inline-end",
  "transform",
  "translate",
  "rotate",
  "scale",
]);

/**
 * A selector is "globally reachable by type" — unsafe for positioning — only
 * when it has NO class/id anchor anywhere (a class/id means the author scoped
 * it intentionally, e.g. `.menu-icon span` or `.foo :global(header)`). With
 * no anchor: in plain CSS any type selector is global; in a Svelte <style>
 * bare types are auto-scoped, so only a type wrapped in :global() reaches out.
 * A bare type's pseudo-element (e.g. `blockquote::before`) is intentionally
 * still flagged in global mode — positioning a pseudo on a reused semantic tag
 * is the same global reach, and the fix is to class the host (#472).
 *
 * @param {import("postcss-selector-parser").Container} selectorNode
 * @param {boolean} scoped
 * @returns {boolean}
 */
function isGloballyReachableType(selectorNode, scoped) {
  let hasClassOrId = false;
  let hasType = false;
  selectorNode.walk((node) => {
    if (node.type === "class" || node.type === "id") hasClassOrId = true;
    else if (node.type === "tag") hasType = true;
  });
  if (hasClassOrId) return false;

  if (scoped) {
    let globalType = false;
    selectorNode.walkPseudos((pseudo) => {
      if (pseudo.value !== ":global") return;
      pseudo.walk((node) => {
        if (node.type === "tag") globalType = true;
      });
    });
    return globalType;
  }

  return hasType;
}

/**
 * True if any ancestor rule in the nested-rule chain is anchored by a class/id.
 * Native CSS nesting (and Svelte `&`) means a nested rule inherits its parents'
 * scope: `.foo { & header { … } }` resolves to `.foo header`, and
 * `.menu-icon { span { … } }` to `.menu-icon span` — both author-scoped, so the
 * inner rule's bare type must not be flagged. We answer only the anchor
 * question, not full `&` resolution, which is all the rule needs.
 *
 * @param {import("postcss").Rule} styleRule
 * @returns {boolean}
 */
function hasAnchoredAncestor(styleRule) {
  let parent = styleRule.parent;
  while (parent && parent.type === "rule") {
    let anchored = false;
    try {
      parser()
        .astSync(parent.selector)
        .walk((node) => {
          if (node.type === "class" || node.type === "id") anchored = true;
        });
    } catch {
      // Unparseable ancestor selector — ignore and keep climbing.
    }
    if (anchored) return true;
    parent = parent.parent;
  }
  return false;
}

/** @type {import("stylelint").Rule} */
const rule = (primary, secondaryOptions) => {
  return (root, result) => {
    const validOptions = utils.validateOptions(
      result,
      ruleName,
      { actual: primary, possible: [true, false] },
      {
        actual: secondaryOptions,
        possible: { mode: ["global", "scoped"] },
        optional: true,
      },
    );
    if (!validOptions || !primary) return;

    // Default (no { mode } passed) is "global": every selector is treated as
    // globally reachable, correct for plain CSS. The config sets mode: "scoped"
    // only for Svelte <style> blocks (postcss-html). validateOptions has
    // already constrained mode to the two literals.
    const scoped = secondaryOptions?.mode === "scoped";

    root.walkRules((styleRule) => {
      // Scan DIRECT-child declarations only: walkDecls() recurses into nested
      // rules and would misattribute a nested decl to this outer selector
      // (double-report). Nested rules are visited on their own by walkRules.
      /** @type {import("postcss").Declaration[]} */
      const offendingDecls = [];
      for (const node of styleRule.nodes) {
        if (
          node.type === "decl" &&
          POSITIONING_PROPS.has(node.prop.toLowerCase())
        ) {
          offendingDecls.push(node);
        }
      }
      if (offendingDecls.length === 0) return;

      // A nested rule under a class/id ancestor is author-scoped (resolves to
      // `.foo header`, `.menu-icon span`, …) — skip, matching the flat case.
      if (hasAnchoredAncestor(styleRule)) return;

      let selectorRoot;
      try {
        selectorRoot = parser().astSync(styleRule.selector);
      } catch {
        return;
      }

      selectorRoot.each((selectorNode) => {
        if (!isGloballyReachableType(selectorNode, scoped)) return;
        for (const decl of offendingDecls) {
          utils.report({
            ruleName,
            result,
            node: decl,
            message: messages.rejected(decl.prop, String(selectorNode).trim()),
          });
        }
      });
    });
  };
};

rule.ruleName = ruleName;
rule.messages = messages;
rule.meta = meta;

export default createPlugin(ruleName, rule);
export { ruleName, messages };
