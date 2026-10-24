// Side-effect entry: imported FIRST by every HTML entry so errors during app module evaluation are captured too.
import { installErrorReporter } from "./error-reporter.ts";
installErrorReporter();
