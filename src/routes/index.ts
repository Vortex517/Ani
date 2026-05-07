import { Router, type IRouter } from "express";
import healthRouter from "./health";
import hianimeRouter from "./hianime";
import imgproxyRouter from "./imgproxy";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/hianime", hianimeRouter);
router.use(imgproxyRouter);

export default router;
