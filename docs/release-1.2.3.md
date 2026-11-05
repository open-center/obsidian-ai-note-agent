# 1.2.3: plugin ID change (unreleased)

## Status

- Current published release: `1.2.2`, ID `notewright`.
- Prepared release: `1.2.3`, ID `ai-note-agent`.
- Display name and repository remain `AI Note Agent` and `open-center/obsidian-ai-note-agent`.
- The community directory change has not been requested or completed.

The [official community directory FAQ](https://docs.obsidian.md/community-directory/faq) says a published entry's identifier cannot be changed by its owner. Request administrator help in [Discord's #community-directory channel](https://discord.com/channels/686053708261228577/1514299829474558013). The FAQ states that changing the identifier resets download counts and requires existing users to reinstall.

Keep this change off the default branch until the administrators confirm how to coordinate the transition. The [directory's installation documentation](https://github.com/obsidianmd/obsidian-releases#how-community-plugins-are-pulled) explains that Obsidian reads the default branch's manifest for the latest version and downloads matching release assets. Publishing or merging the new ID while the directory still expects the old one can leave installation metadata inconsistent.

## Administrator request draft (not sent)

Title: Request to change AI Note Agent's plugin ID from notewright to ai-note-agent

Hello, I maintain AI Note Agent and would like help changing its existing community directory identifier.

- Current identifier: `notewright`
- Requested identifier: `ai-note-agent`
- Repository: https://github.com/open-center/obsidian-ai-note-agent
- Current release: `1.2.2`, using `notewright`
- Prepared next release: `1.2.3`, using `ai-note-agent`

The requested ID matches the plugin's name. Version 1.2.1 briefly used it, but 1.2.2 restored `notewright` because the directory still expected the old identifier. I have now prepared the rename separately, including reinstall instructions and compatibility with existing API key references.

I understand from the FAQ that the change resets download counts and requires existing users to reinstall. Could you confirm whether the identifier change can be made for this entry and the required order for updating the directory, the default-branch manifest, and the release assets? I want to coordinate the transition so installations remain consistent.

## Release checklist

1. Have the maintainer review and send the request above, and agree on the transition order with the directory administrators.
2. Run `npm run build` and `npm run lint`; verify the manifest, package, lockfile, and `versions.json` agree on `1.2.3`.
3. In a disposable vault, test a fresh installation and migration from a backed-up `notewright/data.json`. Verify settings, existing secret references, and new keys. Keep the old plugin disabled.
4. Follow the administrator-confirmed order to merge, tag `1.2.3`, publish its `main.js`, `manifest.json`, and `styles.css`, and update the directory. Do not replace the existing `1.2.2` tag or assets.
5. Verify the official directory entry, default-branch manifest, and downloaded release manifest all use `ai-note-agent`, and test installation from the community browser.
6. Update the pending status in this document and README after the coordinated release is complete.

## Release notes draft

### 中文

- 插件 ID 改为 `ai-note-agent`，显示名称仍为 AI Note Agent。
- 安装目录改为 `.obsidian/plugins/ai-note-agent/`。旧版用户需要重新安装，并按 README 备份和迁移 `data.json`，然后重新绑定命令快捷键。
- 已保存的密钥引用继续有效；新增密钥使用 `ai-note-agent-` 前缀。

### English

- Change the plugin ID to `ai-note-agent`; the display name remains AI Note Agent.
- Install into `.obsidian/plugins/ai-note-agent/`. Existing users must reinstall, back up and transfer `data.json` as described in the README, and reassign command hotkeys.
- Preserve existing secret references; newly stored keys use the `ai-note-agent-` prefix.
