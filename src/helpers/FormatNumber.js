class FormatNumber {
	static formatBoliviaNumber(number) {
		if (!number || typeof number !== "string") {
			return "";
		}

		number = number.replace(/\s+/g, "");

		if (number.startsWith("+591")) {
			number = number.replace("+591", "");
		}

		if (/^\d{8}$/.test(number)) {
			number = "+591" + number;
		}

		return number;
	}
}

module.exports = { FormatNumber };
