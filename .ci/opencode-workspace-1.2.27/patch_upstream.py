from __future__ import annotations

import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()


def patch(relative: str, old: str, new: str, *, count: int = 1) -> None:
    path = root / relative
    text = path.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"{relative}: expected {count} matches, got {actual}: {old[:80]!r}")
    path.write_text(text.replace(old, new), encoding="utf-8")


patch(
    "packages/app/src/components/titlebar.tsx",
    "<Show when={params.dir}>",
    "<Show when={false}>",
)

patch(
    "packages/app/src/pages/layout/sidebar-workspace.tsx",
    "<Show when={!props.touch()}>",
    "<Show when={false}>",
)
patch(
    "packages/app/src/pages/layout/sidebar-workspace.tsx",
    "<Show when={props.showNew()}>",
    "<Show when={false}>",
)

patch(
    "packages/app/src/pages/layout/sidebar-items.tsx",
    '''        <Tooltip value={language.t("common.archive")} placement="top">
          <IconButton
            icon="archive"
            variant="ghost"
            class="size-6 rounded-md"
            aria-label={language.t("common.archive")}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void props.archiveSession(props.session)
            }}
          />
        </Tooltip>''',
    '''        {/* Astra owns Session lifecycle; archive is intentionally unavailable. */}''',
)

patch(
    "packages/app/src/pages/layout.tsx",
    '''      {
        id: "session.archive",
        title: language.t("command.session.archive"),
        category: language.t("command.category.session"),
        keybind: "mod+shift+backspace",
        disabled: !params.dir || !params.id,
        onSelect: () => {
          const session = currentSessions().find((s) => s.id === params.id)
          if (session) archiveSession(session)
        },
      },
''',
    "",
)
patch(
    "packages/app/src/pages/layout.tsx",
    '''        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
            layout.mobileSidebar.hide()
          },
        },
''',
    "",
)
patch(
    "packages/app/src/pages/layout.tsx",
    '''                    <div class="shrink-0 py-4">
                      <Button
                        size="large"
                        icon="new-session"
                        class="w-full"
                        onClick={() => {
                          const dir = worktree()
                          if (!dir) return
                          navigateWithSidebarReset(`/${base64Encode(dir)}/session`)
                        }}
                      >
                        {language.t("command.session.new")}
                      </Button>
                    </div>
''',
    "",
)

patch(
    "packages/app/src/pages/session/use-session-commands.tsx",
    '''      sessionCommand({
        id: "session.new",
        title: language.t("command.session.new"),
        keybind: "mod+shift+s",
        slash: "new",
        onSelect: () => navigate(`/${params.dir}/session`),
      }),
''',
    "",
)
patch(
    "packages/app/src/pages/session/use-session-commands.tsx",
    '''      sessionCommand({
        id: "session.fork",
        title: language.t("command.session.fork"),
        description: language.t("command.session.fork.description"),
        slash: "fork",
        disabled: !params.id || visibleUserMessages().length === 0,
        onSelect: () => dialog.show(() => <DialogFork />),
      }),
''',
    "",
)

print("patched OpenCode v1.2.27 for Astra embedded workspace")
