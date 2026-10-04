import { deleteApp, initializeApp as initClientApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth as getClientAuth, signInWithCustomToken } from "firebase/auth";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { afterAll } from "vitest";
import { FirebaseIssuer } from "../../src/firestore/identity.js";
import { FirestoreRepo } from "../../src/firestore/repo.js";
import { runApiRepoContract } from "./api-repo.contract.js";
import { runIdentityContract } from "./identity.contract.js";

const PROJECT = "demo-chalito";
const admin = getApps()[0] ?? initializeApp({ projectId: PROJECT });
const clientApps: FirebaseApp[] = [];
afterAll(async () => Promise.all(clientApps.map((a) => deleteApp(a))));

runApiRepoContract("FirestoreRepo (emulator)", () => new FirestoreRepo(getFirestore(admin)));

runIdentityContract("FirebaseIssuer (emulator)", () => ({
  issuer: new FirebaseIssuer(getAuth(admin)),
  toBearer: async (customToken) => {
    const app = initClientApp(
      { projectId: PROJECT, apiKey: "demo-key" },
      `contract-${clientApps.length}-${Math.random()}`,
    );
    clientApps.push(app);
    const auth = getClientAuth(app);
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
    return (await signInWithCustomToken(auth, customToken)).user.getIdToken();
  },
}));
