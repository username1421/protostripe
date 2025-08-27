require("dotenv").config();

const express = require("express");
const app = express();
const cors = require("cors");

const { v4: uuid } = require("uuid");
const Stripe = require("stripe");
const Database = require("better-sqlite3");
const db = new Database("data.sqlite");

db.prepare(
  `
  CREATE TABLE IF NOT EXISTS creds (
    id TEXT PRIMARY KEY,
    secretKey TEXT NOT NULL,
    publicKey TEXT NOT NULL
  )
`
).run();

const data = {
  logs: [],
  clients: {},
};

function setCredentials(id, secretKey, publicKey) {
  if (!id || !secretKey || !publicKey) {
    console.error("Invalid credentials data");
    return;
  }

  const insert = db.prepare(
    "INSERT OR REPLACE INTO creds (id, secretKey, publicKey) VALUES (?, ?, ?)"
  );

  insert.run(id, secretKey, publicKey);

  data.clients[id] = Stripe(secretKey);
}

function deleteCredentials(id) {
  if (!id) {
    console.error("Invalid credentials data");
    return;
  }

  const del = db.prepare("DELETE FROM creds WHERE id = ?");
  del.run(id);

  delete data.clients[id];
}

function deleteAllCredentials() {
  db.prepare("DELETE FROM creds").run();

  if (process.env.DEFAULT_CLIENT_RECORD) {
    const [id, secretKey, publicKey] =
      process.env.DEFAULT_CLIENT_RECORD.split(",");

    setCredentials(id, secretKey, publicKey);
  }
}

const GetClientError = {
  UnauthorizedClient: "Stripe client with given id is unauthorized",
};

function getClient(id) {
  const select = db.prepare("SELECT * FROM creds WHERE id = ?");
  const row = select.get(id);

  if (!row || !row.secretKey || !row.publicKey) {
    log({ error: GetClientError.UnauthorizedClient, id });
    throw new Error(GetClientError.UnauthorizedClient);
  }

  if (!data.clients[id]) {
    data.clients[id] = Stripe(row.secretKey);
  }

  return data.clients[id];
}

if (process.env.DEFAULT_CLIENT_RECORD) {
  const [id, secretKey, publicKey] =
    process.env.DEFAULT_CLIENT_RECORD.split(",");

  setCredentials(id, secretKey, publicKey);
}

app.use(
  cors({
    origin: [
      "https://molly-related-informally.ngrok-free.app",
      /http:\/\/192\.168\.1\.34:420\d$/,
      /http:\/\/localhost:420\d$/,
      /elfsight\.com$/,
      /elfsightcdn\.com$/,
      /elf\.site$/,
    ],
  })
);
app.use(express.json());

app.set("view engine", "ejs");
app.set("views", "./templates");

async function ensureDomainRegistered(client_id, domain) {
  const stripe = getClient(client_id);

  try {
    await stripe.paymentMethodDomains.retrieve(domain);
  } catch (err) {
    if (err.code === "resource_missing") {
      return await stripe.paymentMethodDomains.create({
        domain_name: domain,
      });
    } else {
      throw err;
    }
  }
}

// -- create-checkout-session --

app.post("/create-checkout-session", async (req, res) => {
  const { client_id, line_items, customer_email, mode, domain } = req.body;

  try {
    const stripe = getClient(client_id);

    const methodDomain = ensureDomainRegistered(client_id, domain);
    log(methodDomain);

    const sessionData = {
      line_items: line_items,
      mode: mode || "payment",
      ui_mode: "custom",
      return_url: `${process.env.HOST}/return?session_id={CHECKOUT_SESSION_ID}`,
      invoice_creation: {
        enabled: true,
      },
      payment_method_types: ["card"],
    };

    if (customer_email) {
      const customers = await stripe.customers.list({
        limit: 1,
        email: customer_email,
      });

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
    } else {
      sessionData.customer_creation = "always";
      sessionData.saved_payment_method_options = {
        payment_method_save: "enabled",
      };
    }

    const session = await stripe.checkout.sessions.create(sessionData);

    res.send({ clientSecret: session.client_secret, sessionId: session.id });
  } catch (error) {
    console.error("Failed to create session due to reason: ", error);

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
  try {
    const { client_id, session_id } = req.query;
    const stripe = getClient(client_id);

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["payment_intent"],
    });

    const responseData = {
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_details?.email || null,
    };

    if (session.payment_intent) {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent.id
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
  } catch (err) {
    console.error("Failed to get session status due to reason: ", error);
    res.status(500).send({ error: "Failed to get session status" });
  }
});

// -- authorize --

const AuthResultType = {
  Success: "success",
  Fail: "fail",
};

app.post("/authorize", (req, res) => {
  const { secretKey, publicKey } = req.body;
  const clientId = uuid();

  try {
    setCredentials(clientId, secretKey, publicKey);

    res.status(200).send({
      type: AuthResultType.Success,
      id: clientId,
    });
  } catch (error) {
    console.error("Error connecting Stripe account: ", error);

    res.status(500).send({
      type: AuthResultType.Fail,
      reason: error,
    });
  }
});

app.post("/unauthorize", (req, res) => {
  const { clientId } = req.body;

  try {
    deleteCredentials(clientId);

    res.status(200).send({
      type: AuthResultType.Success,
    });
  } catch (error) {
    console.error("Unable to unauthorize account due to: ", error);

    res.status(500).send({
      type: AuthResultType.Fail,
      reason: error,
    });
  }
});

function log(what) {
  try {
    data.logs.push(JSON.stringify({ what, timestamp: Date.now() }));
  } catch (error) {
    console.error(error);
  }
}

app.get("/examine", (_req, res) => {
  const creds = db.prepare("SELECT * FROM creds").all();
  const payload = JSON.stringify({ creds, logs: data.logs });

  res.render("examine", { payload });
});

app.get("/flush", (_req, res) => {
  deleteAllCredentials();

  res.redirect("/examine");
});

app.get("/status", (req, res) => {
  const { status, text } = req.query;

  const action = `console.log('Im here!');`;

  res.render("status", { status, text, action }, (err, html) => {
    res.send(html);
  });
});

app.listen(4242, () => console.log(`I'm here: ${process.env.HOST}`));
