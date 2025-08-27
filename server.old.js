require("dotenv").config();

const express = require("express");
const app = express();
const cors = require("cors");

const myTestSecretKey = process.env.STRIPE_TEST_SECRET_KEY;

const stripe = require("stripe")(myTestSecretKey, {
  apiVersion: "2025-03-31.basil",
});
const { v4: uuid } = require("uuid");

const data = {
  creds: [],
  logs: [],
};

let connectedAccountId = "acct_1RsgIIJD5xdr5twa"; //default mock

app.use(
  cors({
    origin: [
      "http://localhost:4200",
      "http://192.168.1.34:4200",
      "https://molly-related-informally.ngrok-free.app",
      /elfsight\.com$/,
      /elfsightcdn\.com$/,
      /elf\.site$/,
    ],
  })
);
app.use(express.json());

app.set("view engine", "ejs");
app.set("views", "./templates");

// -- create-checkout-session --

app.post("/create-checkout-session", async (req, res) => {
  const { line_items, customer_email, mode, domain } = req.body;

  try {
    try {
      await stripe.paymentMethodDomains.retrieve(domain, {
        stripeAccount: connectedAccountId,
      });
    } catch (err) {
      if (err.code === "resource_missing") {
        const methodDomain = await stripe.paymentMethodDomains.create(
          {
            domain_name: domain,
          },
          { stripeAccount: connectedAccountId }
        );

        log(methodDomain);
      } else {
        throw err;
      }
    }

    const sessionData = {
      line_items: line_items,
      mode: mode || "payment",
      ui_mode: "custom",
      return_url: `https://protostripe-production.up.railway.app/return?session_id={CHECKOUT_SESSION_ID}`,
      invoice_creation: {
        enabled: true,
      },
      payment_method_types: ["card"],
    };

    if (customer_email) {
      const customers = await stripe.customers.list(
        {
          limit: 1,
          email: customer_email,
        },
        {
          stripeAccount: connectedAccountId,
        }
      );

      log(customers);

      if (customers?.data.length > 0) {
        sessionData.customer = customers.data[0]?.id;
      } else {
        sessionData.customer_email = customer_email;
        sessionData.customer_creation = "always";
        sessionData.saved_payment_method_options = {
          payment_method_save: "enabled",
        };
      }
    }

    const session = await stripe.checkout.sessions.create(sessionData, {
      stripeAccount: connectedAccountId,
    });

    res.send({ clientSecret: session.client_secret, sessionId: session.id });
  } catch (error) {
    console.error("Stripe session error:", error);

    res.status(500).send({ error: "Failed to create checkout session" });
  }
});

// -- return --

app.get("/return", (req, res) => {
  const { session_id } = req.query;

  res.status(204).send({
    type: "PAYMENT_COMPLETE",
    sessionId: session_id,
  });

  res.end();
});

// -- session-status --

app.get("/session-status", async (req, res) => {
  const session = await stripe.checkout.sessions.retrieve(
    req.query.session_id,
    {
      expand: ["payment_intent"],
      stripeAccount: connectedAccountId,
    }
  );

  const responseData = {
    status: session.status,
    payment_status: session.payment_status,
    customer_email: session.customer_details?.email || null,
  };

  if (session.payment_intent) {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent.id,
      { stripeAccount: connectedAccountId }
    );

    if (paymentIntent.last_payment_error) {
      const error = paymentIntent.last_payment_error;

      responseData.error = {
        code: error.code,
        decline_code: error.decline_code,
        message: error.message,
        type: error.type,
      };
    }
  }

  res.send(responseData);
});

// -- authorize --

app.get("/authorize", async (req, res) => {
  const { code } = req.query;

  const userId = uuid();

  try {
    const response = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });

    const connectedAccountId = response.stripe_user_id;
    const accessToken = response.access_token;
    const refreshToken = response.refresh_token;
    const publishableKey = response.stripe_publishable_key;

    const account = await stripe.accounts.retrieve(response.stripe_user_id, {
      stripeAccount: connectedAccountId,
    });

    const accountName = getAccountName(account);

    await saveStripeCredentials(userId, {
      stripeAccountId: connectedAccountId,
      accessToken,
      refreshToken,
      publishableKey,
    });

    res.render(
      "status",
      {
        status: "success",
        text: "Auth successful! Redirecting back...",
        action: getPostMessageAction(
          {
            type: "AUTH_SUCCESS",
            payload: { id: userId, pk: publishableKey, accountName },
          },
          true
        ),
      },
      (err, html) => {
        if (err) {
          console.error(err);
          return;
        }

        res.send(html);
      }
    );
  } catch (error) {
    console.error("Error connecting Stripe account:", error);

    res.render(
      "status",
      {
        status: "fail",
        text: `Auth failed due to reason ${error}!`,
        action: getPostMessageAction({
          type: "AUTH_FAILURE",
          reason: error,
        }),
      },
      (err, html) => {
        if (err) {
          console.error(err);
          return;
        }

        res.send(html);
      }
    );
  }
});

async function saveStripeCredentials(userId, credentials) {
  connectedAccountId = credentials.stripeAccountId;

  log({ userId, ...credentials });
}

function log(what) {
  try {
    data.logs.push(JSON.stringify({ what, timestamp: Date.now() }));
  } catch (error) {
    console.error(error);
  }
}

app.get("/examine", (_req, res) => {
  const payload = JSON.stringify(data);

  res.render("examine", { payload });
});

app.get("/status", (req, res) => {
  const { status, text } = req.query;

  const action = `console.log('Im here!');`;

  res.render("status", { status, text, action }, (err, html) => {
    res.send(html);
  });
});

app.listen(4242, () => console.log(`I'm here: http://localhost:${4242}!`));

function getPostMessageAction(data = {}, close = false) {
  try {
    return `
    window.opener.postMessage(${JSON.stringify(data)}, "*");
    ${close ? "setTimeout(() => window.close(), 2000);" : ""}
  `;
  } catch (error) {
    console.error(error);

    return "";
  }
}

function getAccountName(accountData = {}) {
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
