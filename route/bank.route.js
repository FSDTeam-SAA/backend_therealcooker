import express from "express";
import { listPublicBanks } from "../controller/bank.controller.js";

const router = express.Router();
router.get("/", listPublicBanks);
export default router;
