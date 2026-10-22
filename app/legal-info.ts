export function getLegalIdentity() {
  const operatorName = process.env.APP_OPERATOR_NAME === undefined
    ? "Anthony Dellavecchia"
    : process.env.APP_OPERATOR_NAME.trim() || null;
  const rawEmail = process.env.APP_CONTACT_EMAIL === undefined
    ? "adellavecchia@twilio.com"
    : process.env.APP_CONTACT_EMAIL.trim();
  const contactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)
    ? rawEmail
    : null;

  return {
    operatorName,
    contactEmail,
    published: Boolean(operatorName && contactEmail),
  };
}
