# Disclaimer and data handling

**Not financial advice.** This tool copies numbers out of your bank accounts so that a language model can
read them. It does not check them, and neither the tool nor the model is an accountant, a fiduciary or a
financial adviser. Verify anything that matters against your bank's own statements before acting on it.

**The numbers can be wrong.** Plaid's data depends on each bank: balances can be a day old, pending
transactions change or disappear when they post, merchant names and categories are guesses, and some
account types do not report transactions at all. The CSV flips Plaid's sign convention so that money out is
negative; check that assumption against a statement the first time you reconcile.

**Where your data goes.** Your bank data flows from your bank to Plaid, and from Plaid to a machine you
control: your laptop in local mode, your own Fly.io machine in hosted mode. It is stored in a SQLite file
there and in any CSV you export. The author of this project never receives it. Plaid handles your bank
credentials and data under its own terms and privacy policy, and you can revoke its access to any bank at
<https://my.plaid.com> as well as with this tool's unlink command. Deleting the database file and the
exports deletes the local copy.

**You are the operator.** Running this means you hold a Plaid developer account, agree to Plaid's
developer terms, pay Plaid's and Fly's bills, choose the passphrase, and keep the server patched. The
hosted mode is built for one person's data behind one passphrase; it is not designed to hold other
people's bank data, and you should not run it for anyone but your own household.

**No warranty.** The software is provided as is, under the MIT license, without any guarantee that
it is secure, accurate or fit for your purpose. It has had a security review, not an audit, and it is
maintained by one person in their spare time.
