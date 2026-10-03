import { COMPONENT, run } from "./tester.mjs";

run("no-raw-button-strings", {
  valid: [
    {
      name: "a translated label",
      filename: COMPONENT,
      code: `const a = <Button onClick={save}>{t("actions.save")}</Button>;`,
    },
    {
      name: "the T component",
      filename: COMPONENT,
      code: `const a = <Button variant="contained"><T>actions.save</T></Button>;`,
    },
    {
      name: "only whitespace and elements",
      filename: COMPONENT,
      code: `const a = <Button>\n  <SaveIcon />\n</Button>;`,
    },
    {
      name: "other elements may hold text",
      filename: COMPONENT,
      code: `const a = <button>Save</button>;`,
    },
  ],
  invalid: [
    {
      name: "raw text",
      filename: COMPONENT,
      code: `const a = <Button>Save</Button>;`,
      errors: [
        {
          message:
            "Raw string 'Save' in Button component should be localized. Use t('key') or <T>key</T> instead.",
        },
      ],
    },
    {
      name: "a string expression",
      filename: COMPONENT,
      code: `const a = <Button>{"Cancel"}</Button>;`,
      errors: [{ messageId: "noRawButtonStrings", data: { content: "Cancel" } }],
    },
    {
      name: "text around an icon",
      filename: COMPONENT,
      code: `const a = <Button startIcon={<AddIcon />}>New task <Badge /></Button>;`,
      errors: [{ messageId: "noRawButtonStrings", data: { content: "New task" } }],
    },
  ],
});
