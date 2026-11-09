package Cs2Gs.Tests

import Xunit

class Issue5815CallableAndHeaderLiteralRuntimeTests {
    @Fact
    func ReviewUnsignedBoundarySuffixesPreserveNativeOutput() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
class P {
    static void Main() {
        Console.WriteLine(9223372036854775808UL);
        Console.WriteLine(+0x8000_0000_0000_0000uL);
    }
}`, verifyIL: true)
    }

    @Fact
    func InferredLambdaDefaultSurvivesTranslationAndNaturalInvocation() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
class P {
    static void Main() {
        var f = (int x = 7) => x;
        Console.WriteLine(f());
    }
}`, transform: (printed string) -> printed.Replace("f(7)", "f()"), verifyIL: true)
    }

    @Fact
    func InlineForeachArrayInitializersPreserveRuntimeOutput() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
class Item { public int Value; }
class P {
    static void Main() {
        foreach (var item in new Item[] { new Item { Value = 1 } })
            Console.WriteLine(item.Value);
    }
}`, verifyIL: true)
    }

    @Fact
    func SignedInt64MinimumSuffixesPreserveRuntimeOutput() {
        LiteralConstructionRuntimeParity.AssertMatches(`
using System;
class P {
    static long Minimum() => -9223372036854775808L;
    static void Main() {
        Console.WriteLine(Minimum());
        Console.WriteLine(-9_223_372_036_854_775_808l);
    }
}`, verifyIL: true)
    }
}
