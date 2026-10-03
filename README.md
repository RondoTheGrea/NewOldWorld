# NewOldWorld monorepo

## Structure

- `apps/mobile` - React Native app
- `apps/web` - web dashboard
- `firebase/functions` - Firebase endpoint/functions
- `firebase` - Firebase configuration and rules
- `packages/shared` - shared code for apps and backend

## Firebase

- Local emulators: `cd firebase` then `npm install` and `npm run emulators`
- Functions build: handled from `firebase/functions`
- Deploy: `cd firebase` then `npm run deploy` (targets project `newoldworld-b8f5d`)
