// inventory: UsingStatement

package Corpus.Grid03.Constructs

import System

internal class TraceScope : IDisposable {
    private let _name string

    init(name string) {
        _name = name
        Console.WriteLine("UsingStatement: enter $_name")
    }

    func Dispose() {
        Console.WriteLine("UsingStatement: dispose $_name")
    }
}

shared class UsingStatementFixture {
    func Run() {
        {
            using let outer = TraceScope("block-form")
            Console.WriteLine("UsingStatement: inside block form")
        }
        Console.WriteLine("UsingStatement: after block form")
        RunDeclarationForm()
        Console.WriteLine("UsingStatement: after declaration form")
    }

    private func RunDeclarationForm() {
        using let scoped_ = TraceScope("declaration-form")
        Console.WriteLine("UsingStatement: inside declaration form")
    }
}
