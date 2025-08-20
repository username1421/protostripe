export function getPostMessageAction(data = {}, close = false) {
  try {
    return `
    window.opener.postMessage(${JSON.stringify(
      data
    )}, "http://localhost:4200/");
    ${close ? "setTimeout(() => window.close(), 2000);" : ""}
  `;
  } catch (error) {
    console.error(error);

    return "";
  }
}

export function getAccountName(accountData = {}) {
  const { business_profile, individual } = accountData ?? {};

  if (
    !business_profile?.name &&
    !individual?.first_name &&
    !individual?.last_name
  ) {
    return null;
  }

  return (
    business_profile?.name ||
    `${individual?.first_name} ${individual?.last_name}`
  );
}
