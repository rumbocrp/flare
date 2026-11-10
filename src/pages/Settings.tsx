import { useState } from 'react'
import './Settings.css'
import PageHeader from '../components/PageHeader'
import type { AppSettings, ThemeSetting } from '../types'

type SettingsProps = {
  settings: AppSettings
  onChangeSettings: (settings: AppSettings) => void
  onResetAll: () => void
}

const themeOptions: { id: ThemeSetting; label: string }[] = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'system', label: 'Auto' },
]

function Settings({ settings, onChangeSettings, onResetAll }: SettingsProps) {
  const [confirmingReset, setConfirmingReset] = useState(false)

  function handleThemeChange(theme: ThemeSetting) {
    onChangeSettings({ ...settings, theme })
  }

  function handleConfirmReset() {
    onResetAll()
    setConfirmingReset(false)
  }

  return (
    <div className='page'>
      <PageHeader
        title='Settings'
        subtitle='Set it up your way.'
      />

      <section className='setting'>
        <div className='setting__text'>
          <h2 className='setting__title'>Theme</h2>
          <p className='setting__desc'>
            Choose how Flare talks to you
          </p>
        </div>

        <div className='segmented' role='group' aria-label='Theme'>
          {themeOptions.map((option) => (
            <button
              key={option.id}
              type='button'
              className={`segmented__option ${
                settings.theme === option.id ? 'segmented__option--active' : ''
              }`}
              aria-pressed={settings.theme === option.id}
              onClick={() => handleThemeChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className='setting'>
        <div className='setting__text'>
          <h2 className='setting__title'>Trading setup</h2>
          <p className='setting__desc'>
            FLARE is simulation-only. Production version in development.
          </p>
        </div>

        <div className='segmented' role='group' aria-label='Trading setup'>
          <button
            type='button'
            className='segmented__option segmented__option--active'
            aria-pressed='true'
          >
            Simulation
          </button>
        </div>
      </section>

      <section className="setting">
        <div className="setting__text">
          <h2 className="setting__title">Stored data</h2>
          <p className="setting__desc">
            Only your strategies and your settings are saved.
            The bot status resets back to "STOP" when it's not supervised.
          </p>
        </div>

        {confirmingReset ? (
          <div className='setting__confirm'>
            <span>Are you sure? Your strategies and settings will be restablished.</span>
            <button
              type='button'
              className='btn btn--danger'
              onClick={handleConfirmReset}
            >
              Yes, restore data
            </button>
            <button
              type='button'
              className='btn'
              onClick={() => setConfirmingReset(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type='button'
            className='btn'
            onClick={() => setConfirmingReset(true)}
          >
            Restore data
          </button>
        )}
      </section>
    </div>
  )
}

export default Settings
