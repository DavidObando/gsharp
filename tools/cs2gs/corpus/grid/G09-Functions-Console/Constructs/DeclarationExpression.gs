// inventory: DeclarationExpression

package Corpus.Grid09

import System
import System.Collections.Generic

shared class DeclarationExpressionFixture {
    func Run() {
        // out var + SingleVariableDesignation.
        if int32.TryParse("42", out var n) {
            Console.WriteLine("DeclarationExpression: outVar=$n")
        }
        // Explicitly typed out declaration.
        let okTyped = int32.TryParse("7", out var m)
        Console.WriteLine("DeclarationExpression: outTyped=$m ok=$okTyped")
        // DiscardDesignation: out _.
        let okDiscard = int32.TryParse("nope", out _)
        Console.WriteLine("DeclarationExpression: discardParse=$okDiscard")
        let ages = Dictionary[string, int32]{"ada": 36}
        if ages.TryGetValue("ada", out var age) {
            Console.WriteLine("DeclarationExpression: tryGet=$age")
        }
        let found = ages.TryGetValue("bob", out var missing)
        Console.WriteLine("DeclarationExpression: missing=$missing found=$found")
    }
}
