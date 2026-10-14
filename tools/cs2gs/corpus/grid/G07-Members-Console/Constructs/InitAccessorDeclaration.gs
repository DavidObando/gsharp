// inventory: InitAccessorDeclaration — init-only property set via object initializer (probe)

package Corpus.Grid07

import System

open class FrozenLabel {
    init() {
        Text = "empty"
    }

    prop Text string {
        get;
        init;
    }
}

shared class InitAccessorDeclarationFixture {
    func Run() {
        let label = FrozenLabel{Text: "sealed"}
        Console.WriteLine("InitAccessorDeclaration: text=" + label.Text)
        let fallback = FrozenLabel()
        Console.WriteLine("InitAccessorDeclaration: default=" + fallback.Text)
    }
}
