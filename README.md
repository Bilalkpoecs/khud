# khud

**Cross-agent identity compiler — خود**

[![Socket Badge](https://badge.socket.dev/npm/package/khud/0.3.3)](https://badge.socket.dev/npm/package/khud/0.3.3)

**khud is a cross-agent identity and memory compiler for AI coding agents.**
It gives Claude Code, Codex, OpenCode, Cursor, Pi and Hermes one shared profile
and one shared memory, instead of six drifting copies.

If you use more than one AI coding agent, each wants your context in its own
format, in its own file, in its own directory: `CLAUDE.md` for Claude Code,
`AGENTS.md` for Codex, an identity file for OpenCode, an `.mdc` rule for Cursor.
So you either write the same preferences six times and watch them drift, or you
give the weaker agents nothing.

khud keeps one canonical profile in `~/.khud/profile.json`, compiles it into
each agent's native instruction format, and keeps them in sync. Write it once.

```bash
npm install -g khud
khud setup
khud status
```

## What it actually does

**One profile, many agents.** `khud sync` compiles `~/.khud/profile.json` into
each agent's own instruction file. Change a preference in
one place; every agent picks it up.

**Session memory that survives.** Session hooks capture work in progress to an
inbox. `khud finalize` locks those captures and writes them into Obsidian as
episodes and decisions, then reindexes them in turbovec so they are retrievable
later.

**Nothing lands without your say-so.** Agent-written summaries stay pending
until you look at them. `khud diff` shows what an agent wants to add,
`khud approve` accepts it, `khud reject` throws it away. Preferences are promoted
only when there is evidence behind them, not because an agent asserted one once.

## Which AI coding agents does khud support?

Six targets. khud writes the file each agent already reads at session start, so
there is nothing to configure inside the agent itself:

| Agent | File khud writes |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex CLI | `~/.codex/AGENTS.md` |
| OpenCode | `~/.config/opencode/agents/khud-identity.md` |
| Cursor | `~/.cursor/rules/khud.mdc` |
| Pi | `~/.pi/agent/AGENTS.md` |
| Hermes | `~/.hermes/SOUL.md` |

`khud setup` detects which of these are actually installed and wires only those.
It will not create config for an agent you do not use.

Codex and Pi both concatenate ancestor `AGENTS.md` files into their effective
context, which khud accounts for when it compiles.

**Not wired today.** The 2026 agent landscape is wider than these six: GitHub
Copilot agent mode, Windsurf, Cline, Aider, Continue.dev, Roo Code, Kilo Code,
Devin, Antigravity CLI and Grok Build. Anything that reads a plain `AGENTS.md`
can be pointed at khud's compiled output by hand, but there is no detection or
hook installation for it. Open an issue if you want one added.

## Platform support

| Platform | Status |
|---|---|
| Linux | verified |
| macOS | platform-aware path resolution |
| Windows | platform-aware path resolution |

Home, config, plugin and agent paths resolve per platform rather than assuming
Linux defaults.

## Commands

### Daily use

```bash
khud status        # what is wired, what is pending
khud show          # print the canonical profile
khud sync          # recompile the profile into every agent's format
khud diff          # show the pending agent-written summary
khud approve       # accept it
khud reject        # discard it
```

### Setup and profile

```bash
khud setup                    # detect agents and wire this machine
khud setup --reset-profile    # replace the local profile with the seed profile
khud init                     # initialise with your profile
khud set                      # set profile values
khud add                      # add to the profile
khud context                  # inspect shared instructions without touching live files
khud history                  # recent profile changes
```

### Memory pipeline

```bash
khud capture             # write or validate session captures
khud finalize            # lock inbox captures into Obsidian and the profile
khud finalize-hook       # ingest stop-hook JSON from stdin, then finalize
khud migrate-decisions   # split Decision-Log.md into per-entry temporal notes
```

## What `khud setup` does

- creates `~/.khud/profile.json` if it does not exist
- keeps your existing profile unless `--reset-profile` is passed
- detects installed Claude Code, Codex, OpenCode, Cursor, Pi and Hermes targets
- writes the agent-specific identity files for detected targets
- installs the session hook files for detected targets

## Contributing

```bash
npm run build
npm test
```

Issues and pull requests: https://github.com/Bilalkpoecs/khud/issues

## Author

<div class="gravatar-hovercard"><style></style>
            <div class="gravatar-hovercard__inner">
                <div class="gravatar-hovercard__header-image" style="background: url(&quot;https://0.gravatar.com/userimage/263572057/ca1a9acd41d5b98f6493e8fb1ea89a6d?size=1024&quot;) 50% 50% / 100% auto no-repeat;"></div>
                <div class="gravatar-hovercard__header">
                    <a class="gravatar-hovercard__avatar-link" href="https://gravatar.com/bilalkpoecs?utm_source=hovercard" target="_blank">
                        <img class="gravatar-hovercard__avatar" src="https://1.gravatar.com/avatar/0bae96d987a7b6e8f34bd3ebe6d4db5c8c027e901b5fe3882ddff5be6e8e9636?s=256&amp;d=initials" width="104" height="104" alt="Bilal Ahmad">
                    </a>
                    <a class="gravatar-hovercard__personal-info-link" href="https://gravatar.com/bilalkpoecs?utm_source=hovercard" target="_blank">
                        <h4 class="gravatar-hovercard__name">Bilal Ahmad</h4>
                        <p class="gravatar-hovercard__job">AI Agents &amp; Automation Engineer</p>
                        <p class="gravatar-hovercard__location">Mandi Bhaudin Punjab Pakistan</p>
                    </a>
                </div>
                <div class="gravatar-hovercard__body">
                                <p class="gravatar-hovercard__description">I build AI agents that run every day, unattended. ⚙️ [BilalFlowgrammer]</p>
                            </div>
                <div class="gravatar-hovercard__social-links">
                    <a class="gravatar-hovercard__social-link" href="https://gravatar.com/bilalkpoecs?utm_source=hovercard" target="_blank" data-service-name="gravatar">
                        <img class="gravatar-hovercard__social-icon" src="https://s.gravatar.com/icons/gravatar.svg" width="32" height="32" alt="Gravatar">
                    </a>
                    
                    <a class="gravatar-hovercard__social-link" href="https://x.com/BilalGFXWala" target="_blank" data-service-name="twitter">
                        <img class="gravatar-hovercard__social-icon" src="https://s.gravatar.com/icons/x.svg" width="32" height="32" alt="X">
                    </a>
                
                    <a class="gravatar-hovercard__social-link" href="https://www.linkedin.com/in/bilalflowgrammer" target="_blank" data-service-name="linkedin">
                        <img class="gravatar-hovercard__social-icon" src="https://s.gravatar.com/icons/linkedin.svg" width="32" height="32" alt="LinkedIn">
                    </a>
                
                    <a class="gravatar-hovercard__social-link" href="https://github.com/Bilalkpoecs" target="_blank" data-service-name="github">
                        <img class="gravatar-hovercard__social-icon" src="https://s.gravatar.com/icons/github.svg" width="32" height="32" alt="GitHub">
                    </a>
                
                </div>
                
                <div class="gravatar-hovercard__buttons">
                    <button class="gravatar-hovercard__button" data-target-drawer="contact">Contact</button>
                </div>
            
                <div class="gravatar-hovercard__footer">
                    <a class="gravatar-hovercard__profile-url" title="https://gravatar.com/bilalkpoecs" href="https://gravatar.com/bilalkpoecs?utm_source=profile-card" target="_blank">
                        gravatar.com/bilalkpoecs
                    </a>
                    <a class="gravatar-hovercard__profile-link" href="https://gravatar.com/bilalkpoecs?utm_source=profile-card" target="_blank">
                        View profile →
                    </a>
                </div>
                
            <div class="gravatar-hovercard__drawer" data-drawer-name="contact">
                <div class="gravatar-hovercard__drawer-backdrop" data-target-drawer="contact"></div>
                <div class="gravatar-hovercard__drawer-card">
                    <div class="gravatar-hovercard__drawer-header">
                        <h2 class="gravatar-hovercard__drawer-title">Contact</h2>
                        <button class="gravatar-hovercard__drawer-close" data-target-drawer="contact">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M12 13.0607L15.7123 16.773L16.773 15.7123L13.0607 12L16.773 8.28772L15.7123 7.22706L12 10.9394L8.28771 7.22705L7.22705 8.28771L10.9394 12L7.22706 15.7123L8.28772 16.773L12 13.0607Z" fill="#101517"></path>
                            </svg>
                        </button>
                    </div>
                    <ul class="gravatar-hovercard__drawer-items">
                        
                <li class="gravatar-hovercard__drawer-item">
                    <img class="gravatar-hovercard__drawer-item-icon" width="24" height="24" src="https://s.gravatar.com/icons/mail.svg" alt="">
                    <div class="gravatar-hovercard__drawer-item-info">
                        <span class="gravatar-hovercard__drawer-item-label">Email</span>
                        <span class="gravatar-hovercard__drawer-item-text"><a class="gravatar-hovercard__drawer-item-link" href="mailto:bilalkpoecs@gmail.com" target="_blank">bilalkpoecs@gmail.com</a></span>
                    </div>
                </li>
            
                <li class="gravatar-hovercard__drawer-item">
                    <img class="gravatar-hovercard__drawer-item-icon" width="24" height="24" src="https://s.gravatar.com/icons/calendar.svg" alt="">
                    <div class="gravatar-hovercard__drawer-item-info">
                        <span class="gravatar-hovercard__drawer-item-label">Calendar</span>
                        <span class="gravatar-hovercard__drawer-item-text"><a class="gravatar-hovercard__drawer-item-link" href="https://cal.com/bilal-ahmad-automation/30-min-discovery-call" target="_blank">cal.com/bilal-ahmad-automation/30-min-discovery-call</a></span>
                    </div>
                </li>
            
                <li class="gravatar-hovercard__drawer-item">
                    <img class="gravatar-hovercard__drawer-item-icon" width="24" height="24" src="https://s.gravatar.com/icons/mobile-phone.svg" alt="">
                    <div class="gravatar-hovercard__drawer-item-info">
                        <span class="gravatar-hovercard__drawer-item-label">Cell Phone</span>
                        <span class="gravatar-hovercard__drawer-item-text">+923394936887</span>
                    </div>
                </li>
            
                    </ul>
                </div>
            </div>
        
                
                <div class="gravatar-hovercard__profile-color" style="background: linear-gradient(138deg, rgb(235, 79, 39) 0%, rgb(244, 142, 93) 43%, rgb(252, 84, 35) 80%, rgb(235, 79, 39) 100%);"></div>
            </div>
        <script>
        const hovercardInner = document.querySelector('.gravatar-hovercard__inner');

        function openDrawer( target, container ) {
            const selector = '.gravatar-hovercard__drawer[data-drawer-name="' + target.dataset.targetDrawer + '"]';
            const drawer = container.querySelector( selector );
            drawer?.classList.add( 'gravatar-hovercard__drawer--open' );
        }

        function closeDrawer( target, container ) {
            const selector = '.gravatar-hovercard__drawer[data-drawer-name="' + target.dataset.targetDrawer + '"]';
            const drawer = container.querySelector( selector );
            drawer?.classList.add( 'gravatar-hovercard__drawer--closing' );
            drawer?.classList.remove( 'gravatar-hovercard__drawer--open' );

            setTimeout( () => {
                drawer?.classList.remove( 'gravatar-hovercard__drawer--closing' );
            }, 300 );
        }

        hovercardInner.querySelectorAll( '.gravatar-hovercard__button' ).forEach( ( el ) => {
            el.addEventListener( 'click', () => openDrawer( el, hovercardInner ) );
        } );
        hovercardInner.querySelectorAll( '.gravatar-hovercard__drawer-close' ).forEach( ( el ) => {
            el.addEventListener( 'click', () => closeDrawer( el, hovercardInner ) );
        } );
        hovercardInner.querySelectorAll( '.gravatar-hovercard__drawer-backdrop' ).forEach( ( el ) => {
            el.addEventListener( 'click', () => closeDrawer( el, hovercardInner ) );
        } );
    </script></div>

Bilal Ahmad, AI agents and automation engineer.
[gravatar.com/bilalkpoecs](https://gravatar.com/bilalkpoecs)

## License

MIT
