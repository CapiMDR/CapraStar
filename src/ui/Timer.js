class Timer {
  constructor(time, increment = 0, elementID = null) {
    this.isUnlimited = !Number.isFinite(time);
    this.initialTime = this.isUnlimited ? Infinity : time * 60;
    this.remainingTime = this.initialTime;

    this.intervalID = null;
    this.isPaused = false;

    this.increment = increment;
    this.onTimeOut = null;
    this.onTimeWarning = null;

    this.elementID = elementID;
    this.element = elementID ? document.getElementById(elementID) : null;

    this.updateDisplay();
  }

  getTime() {
    if (this.isUnlimited) return "\u221E";
    return this.convertSeconds(this.remainingTime);
  }

  convertSeconds(s) {
    s = Math.max(0, Math.floor(s));

    const minu = Math.floor(s / 60);
    const sec = s % 60;

    return nf(minu, 2) + ":" + nf(sec, 2);
  }

  updateDisplay() {
    if (!this.element) return;

    this.element.textContent = this.getTime();

    const timerBox = this.element.closest(".timerBox");

    if (!timerBox) return;

    timerBox.classList.toggle("low-time", !this.isUnlimited && this.remainingTime <= 30 && this.remainingTime > 0);
  }

  setActive(active) {
    if (!this.element) return;

    const timerBox = this.element.closest(".timerBox");

    if (!timerBox) return;

    timerBox.classList.toggle("active", active);
  }

  start() {
    if (this.intervalID) return;

    this.isPaused = false;
    this.updateDisplay();
    this.notifyTimeWarning();

    if (this.isUnlimited) return;

    this.intervalID = setInterval(() => {
      if (this.isPaused) return;

      this.remainingTime--;

      this.updateDisplay();
      this.notifyTimeWarning();

      if (this.remainingTime <= 0) {
        this.remainingTime = 0;

        this.updateDisplay();
        this.stop();
        this.setActive(false);

        this.onTimeOut?.();
      }
    }, 1000);
  }

  notifyTimeWarning() {
    if (this.isUnlimited || this.remainingTime <= 0) return;
    const shouldRing = this.remainingTime === 30 || this.remainingTime === 10 || this.remainingTime <= 5;
    if (shouldRing) this.onTimeWarning?.(this.remainingTime);
  }

  pause() {
    if (this.isPaused) return;

    this.isPaused = true;

    if (!this.isUnlimited) this.remainingTime += this.increment;

    this.updateDisplay();
    this.setActive(false);
  }

  play() {
    this.isPaused = false;
    this.setActive(true);
    this.updateDisplay();
  }

  stop() {
    if (this.intervalID) {
      clearInterval(this.intervalID);
      this.intervalID = null;
    }

    this.setActive(false);
  }

  reset() {
    this.stop();

    this.remainingTime = this.initialTime;
    this.isPaused = false;

    this.updateDisplay();
    this.setActive(false);
  }

  setTimeControl(minutes, increment = 0, unlimited = false) {
    this.stop();
    this.isUnlimited = unlimited;
    this.initialTime = unlimited ? Infinity : minutes * 60;
    this.remainingTime = this.initialTime;
    this.increment = unlimited ? 0 : increment;
    this.isPaused = false;
    this.updateDisplay();
  }

  setTime(seconds) {
    if (this.isUnlimited) return;
    this.remainingTime = Math.max(0, seconds);
    this.updateDisplay();
  }

  addSeconds(seconds) {
    if (this.isUnlimited) return;
    if (this.remainingTime <= 0 && seconds < 0) return;
    this.remainingTime += seconds;
    this.updateDisplay();
  }
}
