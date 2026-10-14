// inventory: TryStatement

package Corpus.Grid03.Constructs

import System

shared class TryStatementFixture {
    func Run() {
        for var code = 0; code <= 2; code++ {
            try {
                ThrowFor(code)
                Console.WriteLine("TryStatement: code $code completed without throwing")
            } catch (ex InvalidOperationException) {
                Console.WriteLine("TryStatement: InvalidOperationException handler caught ${ex.Message}")
            } catch (ex ArgumentException) {
                Console.WriteLine("TryStatement: ArgumentException handler caught ${ex.Message}")
            } finally {
                Console.WriteLine("TryStatement: finally ran for code $code")
            }
        }
        try {
            try {
                throw InvalidOperationException("inner failure")
            } catch (InvalidOperationException) {
                Console.WriteLine("TryStatement: inner handler rethrowing")
                rethrow
            }
        } catch (ex InvalidOperationException) {
            Console.WriteLine("TryStatement: outer handler caught rethrown ${ex.Message}")
        }
    }

    private func ThrowFor(code int32) {
        if code == 1 {
            throw InvalidOperationException("invalid operation")
        }
        if code == 2 {
            throw ArgumentException("bad argument")
        }
    }
}
