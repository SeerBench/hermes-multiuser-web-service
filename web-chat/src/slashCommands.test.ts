import { describe, expect, it } from 'vitest'

import type { CommandSpec } from './api'
import { filterSlashCommands } from './slashCommands'

const COMMANDS: CommandSpec[] = [
  {
    name: 'help',
    description: 'Show help',
    description_i18n: { en: 'Show help', zh: '显示帮助' },
    category: 'Info',
    args_hint: '',
    aliases: ['h'],
    subcommands: [],
    client_only: false,
    supported: true,
  },
  {
    name: 'skills',
    description: 'Manage skills',
    description_i18n: { en: 'Manage skills', zh: '管理技能' },
    category: 'Tools',
    args_hint: '[name]',
    aliases: [],
    subcommands: [],
    client_only: false,
    supported: true,
  },
]

describe('filterSlashCommands', () => {
  it('returns all commands when query is empty', () => {
    expect(filterSlashCommands('', COMMANDS, 'en')).toHaveLength(2)
  })

  it('matches by command name', () => {
    expect(filterSlashCommands('hel', COMMANDS, 'en').map((c) => c.name)).toEqual([
      'help',
    ])
  })

  it('matches by alias', () => {
    expect(filterSlashCommands('h', COMMANDS, 'en').map((c) => c.name)).toEqual([
      'help',
    ])
  })

  it('matches localized description', () => {
    expect(filterSlashCommands('技能', COMMANDS, 'zh').map((c) => c.name)).toEqual([
      'skills',
    ])
  })
})
