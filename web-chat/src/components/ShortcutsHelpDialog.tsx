import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useT } from '../i18n'

export { isEditableKeyboardTarget } from '../chatHotkeys'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Row = { keys: string; actionKey: string }

const ROWS: Row[] = [
  { keys: 'Enter', actionKey: 'shortcuts.send' },
  { keys: 'n', actionKey: 'shortcuts.newChat' },
  { keys: '/', actionKey: 'shortcuts.focusComposer' },
  { keys: '?', actionKey: 'shortcuts.openHelp' },
]

/** Modal shortcut reference; Radix Dialog provides focus trap. */
export function ShortcutsHelpDialog({ open, onOpenChange }: Props) {
  const t = useT()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.hint')}</DialogDescription>
        </DialogHeader>
        <table className="shortcuts-table">
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.actionKey}>
                <td>
                  <kbd className="shortcuts-kbd">{row.keys}</kbd>
                </td>
                <td>{t(row.actionKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  )
}
