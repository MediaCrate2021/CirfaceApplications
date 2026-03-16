export default function Login() {
  const error = new URLSearchParams(window.location.search).get('error');

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>Migration Tool</h1>
        <p className="subtitle">Migrate project data to Asana. Authorise with your Cirface account to continue.</p>
        <a href="/auth/login" className="btn btn-primary btn-lg">Connect with Asana</a>
        {error && (
          <p className="error-text">
            {error === 'access_denied'
              ? 'Access was denied. Please try again.'
              : 'Authentication failed. Please try again.'}
          </p>
        )}
        <p className="legal-links">
          By connecting, you agree to our{' '}
          <a href="/terms.html">Terms of Use</a> and{' '}
          <a href="/privacy.html">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}
