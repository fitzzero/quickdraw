# @fitzzero/quickdraw-lint

The quickdraw oxlint plugin (`plugin/`) and the shared base config every
quickdraw app extends (`oxlint.base.jsonc`).

```jsonc
// .oxlintrc.json in your app
{
  "extends": ["./node_modules/@fitzzero/quickdraw-lint/oxlint.base.jsonc"],
}
```

The base config loads the plugin through a path relative to itself, so apps do
not need their own `jsPlugins` entry. See the comment at the top of
`oxlint.base.jsonc` for what an extending config inherits and what it must
declare itself.

The rules are the 4.1 set, moved here unchanged. The 5.0 rule set is described
in `docs/rfcs/0003-v5.md` section 14.
