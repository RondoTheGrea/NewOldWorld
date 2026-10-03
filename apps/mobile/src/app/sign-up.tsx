import { Link } from 'expo-router';

import { AuthForm } from '@/components/auth-form';
import { ThemedText } from '@/components/themed-text';
import { useAuth } from '@/context/auth';

export default function SignUpScreen() {
  const { signUp } = useAuth();

  return (
    <AuthForm
      title="Sign up"
      submitLabel="Create account"
      onSubmit={signUp}
      newPassword
      footer={
        <>
          <ThemedText type="small" themeColor="textSecondary">
            Already have an account?
          </ThemedText>
          <Link href="/sign-in" replace>
            <ThemedText type="linkPrimary">Log in</ThemedText>
          </Link>
        </>
      }
    />
  );
}
