import assert = require("assert");
import moment = require("moment");
import Models = require("../src/share/models");
import Stats = require("../src/server/statistics");

describe("EwmaStatisticCalculator", () => {
    it("Should work", () => {
        var input = [268.05, 258.73, 239.82, 250.21, 224.49, 242.53, 248.25, 270.58, 252.77, 273.55,
                     255.9, 226.1, 225, 263.12, 218.36, 254.73, 218.65, 252.4, 296.1, 222.2];

        var calc = new Stats.EwmaStatisticCalculator(.095, <Models.RegularFairValue[]>input.map(x => new Models.RegularFairValue(moment.utc(), x)));

        assert(Math.abs(calc.latest - 249.901486) < 1e-5);
    });
});
