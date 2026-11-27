
import { initializeApp, getApps } from
  "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";

import {
  getFirestore,
  doc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-functions.js";

// Use exactly the same Firebase config as index.html.
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "asia-south1");

const createSubscription = httpsCallable(functions, "createSubscription");
const verifyCheckout = httpsCallable(functions, "verifySubscriptionCheckout");
const cancelSubscription = httpsCallable(functions, "cancelSubscription");

const $ = id => document.getElementById(id);

let currentUser = null;
let currentMembership = null;
let stopMembershipListener = null;

function message(text, error = false) {
  const element = $("paymentMessage");
  if (!element) return;
  element.textContent = text;
  element.classList.toggle("error", error);
}

function setButtonsDisabled(disabled) {
  document.querySelectorAll("[data-subscribe]").forEach(button => {
    button.disabled = disabled;
  });
}

function renderMembership(data) {
  currentMembership = data || null;

  if (!currentUser) {
    $("premiumStatus").textContent = "Login to view your membership.";
    $("premiumExpiry").textContent = "";
    $("cancelSubscription").classList.add("hidden");
    return;
  }

  if (!data) {
    $("premiumStatus").textContent = "Free membership";
    $("premiumExpiry").textContent = "Choose a Pro plan to upgrade.";
    $("cancelSubscription").classList.add("hidden");
    return;
  }

  const expiry = data.premiumUntil?.toDate
    ? data.premiumUntil.toDate()
    : null;

  const active = Boolean(
    data.isPremium &&
    expiry &&
    expiry.getTime() > Date.now()
  );

  $("premiumStatus").textContent = active
    ? `NEXORA Pro — ${data.planName || data.planKey}`
    : "Free membership / No current paid period";

  $("premiumExpiry").textContent = expiry
    ? `Paid access until: ${expiry.toLocaleString()}`
    : "";

  const canCancel = active &&
    data.razorpaySubscriptionId &&
    data.status !== "cancelled" &&
    data.status !== "completed";

  $("cancelSubscription").classList.toggle("hidden", !canCancel);
  $("cancelSubscription").textContent = data.cancellationRequested
    ? "Renewal cancellation requested"
    : "Cancel renewal";

  $("cancelSubscription").disabled = Boolean(data.cancellationRequested);
}

function listenToMembership(user) {
  if (stopMembershipListener) {
    stopMembershipListener();
    stopMembershipListener = null;
  }

  if (!user) {
    renderMembership(null);
    return;
  }

  const membershipRef = doc(db, "users", user.uid, "billing", "current");

  stopMembershipListener = onSnapshot(
    membershipRef,
    snapshot => renderMembership(snapshot.exists() ? snapshot.data() : null),
    error => {
      console.error("Membership listener failed:", error);
      message("Could not load membership. Please refresh.", true);
    }
  );
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  listenToMembership(user);

  if (!user) {
    message("Login first to purchase NEXORA Pro.");
  } else {
    message(`Logged in as ${user.email}`);
  }
});

async function startSubscription(planKey) {
  if (!currentUser) {
    message("Please login before purchasing a plan.", true);
    return;
  }

  if (!window.Razorpay) {
    message("Razorpay Checkout did not load. Refresh the page.", true);
    return;
  }

  setButtonsDisabled(true);
  message("Creating your secure subscription...");

  try {
    const result = await createSubscription({ planKey });
    const subscription = result.data;

    const options = {
      key: subscription.keyId,
      subscription_id: subscription.subscriptionId,
      name: "NEXORA",
      description: subscription.planName,
      image: "",
      prefill: {
        email: currentUser.email || ""
      },
      notes: {
        product: "NEXORA Pro"
      },
      theme: {
        color: "#7c6cff"
      },
      handler: async response => {
        message("Payment received by Checkout. Verifying securely...");

        try {
          const verified = await verifyCheckout({
            subscriptionId: subscription.subscriptionId,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature
          });

          if (verified.data.verified) {
            message(
              "Checkout verified. Your membership will activate after Razorpay confirms the subscription."
            );
          }
        } catch (error) {
          console.error("Checkout verification failed:", error);
          message(
            "We could not verify this checkout. Do not pay again yet; contact support with your payment details.",
            true
          );
        }
      },
      modal: {
        ondismiss: () => {
          message("Checkout closed. No membership was activated by this action.");
        }
      }
    };

    const checkout = new Razorpay(options);

    checkout.on("payment.failed", response => {
      console.error("Razorpay payment failed:", response.error);
      message(
        response.error?.description || "Payment failed. Please try again.",
        true
      );
    });

    checkout.open();
  } catch (error) {
    console.error("Subscription creation failed:", error);
    message(
      error.message || "Could not start subscription. Please try again.",
      true
    );
  } finally {
    setButtonsDisabled(false);
  }
}

document.querySelectorAll("[data-subscribe]").forEach(button => {
  button.addEventListener("click", () => {
    startSubscription(button.dataset.subscribe);
  });
});

$("cancelSubscription")?.addEventListener("click", async () => {
  if (!currentUser || !currentMembership?.razorpaySubscriptionId) {
    message("No active subscription found.", true);
    return;
  }

  const confirmed = window.confirm(
    "Cancel automatic renewal? Your already-paid period may remain available until its expiry date."
  );

  if (!confirmed) return;

  $("cancelSubscription").disabled = true;
  message("Sending cancellation request...");

  try {
    const result = await cancelSubscription({
      subscriptionId: currentMembership.razorpaySubscriptionId
    });

    message(result.data.message);
  } catch (error) {
    console.error("Cancellation failed:", error);
    message(error.message || "Could not cancel subscription.", true);
    $("cancelSubscription").disabled = false;
  }
});
