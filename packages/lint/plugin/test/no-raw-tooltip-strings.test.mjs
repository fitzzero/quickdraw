import { COMPONENT, run } from "./tester.mjs";

run("no-raw-tooltip-strings", {
  valid: [
    {
      name: "a translated title",
      filename: COMPONENT,
      code: `const a = <Tooltip title={t("task.archive")}><IconButton /></Tooltip>;`,
    },
    {
      name: "an empty title",
      filename: COMPONENT,
      code: `const a = <Tooltip title=""><span /></Tooltip>;`,
    },
    {
      name: "a title from a variable",
      filename: COMPONENT,
      code: `const a = <Tooltip title={label}><span /></Tooltip>;`,
    },
    {
      name: "other elements' titles",
      filename: COMPONENT,
      code: `const a = <abbr title="Coordinated Universal Time">UTC</abbr>;`,
    },
  ],
  invalid: [
    {
      name: "a raw title attribute",
      filename: COMPONENT,
      code: `const a = <Tooltip title="Archive"><IconButton /></Tooltip>;`,
      errors: [
        {
          message:
            "Raw string 'Archive' in Tooltip title should be localized. Use t('key') instead.",
        },
      ],
    },
    {
      name: "a string expression",
      filename: COMPONENT,
      code: `const a = <Tooltip title={"Delete forever"}><IconButton /></Tooltip>;`,
      errors: [{ messageId: "noRawTooltipStrings", data: { content: "Delete forever" } }],
    },
    {
      name: "with other props",
      filename: COMPONENT,
      code: `const a = <Tooltip placement="top" title="Copy link" arrow><IconButton /></Tooltip>;`,
      errors: [{ messageId: "noRawTooltipStrings", data: { content: "Copy link" } }],
    },
  ],
});
