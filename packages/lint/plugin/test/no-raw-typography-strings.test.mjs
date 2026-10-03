import { COMPONENT, run } from "./tester.mjs";

run("no-raw-typography-strings", {
  valid: [
    {
      name: "a translated string",
      filename: COMPONENT,
      code: `const a = <Typography variant="h6">{t("board.title")}</Typography>;`,
    },
    {
      name: "data from the server",
      filename: COMPONENT,
      code: `const a = <Typography>{task.title}</Typography>;`,
    },
    {
      name: "the T component",
      filename: COMPONENT,
      code: `const a = <Typography><T>board.empty</T></Typography>;`,
    },
    {
      name: "other elements may hold text",
      filename: COMPONENT,
      code: `const a = <p>Loading</p>;`,
    },
  ],
  invalid: [
    {
      name: "raw text",
      filename: COMPONENT,
      code: `const a = <Typography>No tasks yet</Typography>;`,
      errors: [
        {
          message:
            "Raw string 'No tasks yet' in Typography component should be localized. Use t('key') or <T>key</T> instead.",
        },
      ],
    },
    {
      name: "a string expression",
      filename: COMPONENT,
      code: `const a = <Typography variant="caption">{"Saved"}</Typography>;`,
      errors: [{ messageId: "noRawTypographyStrings", data: { content: "Saved" } }],
    },
    {
      name: "text next to data",
      filename: COMPONENT,
      code: `const a = <Typography>Assigned to {user.name}</Typography>;`,
      errors: [{ messageId: "noRawTypographyStrings", data: { content: "Assigned to" } }],
    },
  ],
});
