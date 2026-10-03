import { Link } from 'expo-router';

import { AuthForm } from '@/components/auth-form';
import { ThemedText } from '@/components/themed-text';
import { useAuth } from '@/context/auth';

export default function SignInScreen() {
  const { signIn } = useAuth();

  return (
    <AuthForm
      title="Log in"
      submitLabel="Log in"
      onSubmit={signIn}
      footer={
        <>
          <ThemedText type="small" themeColor="textSecondary">
            No account yet?
          </ThemedText>
          <Link href="/sign-up" replace>
            <ThemedText type="linkPrimary">Sign up</ThemedText>
          </Link>
        </>
      }
    />
  );
}
