// inventory: ConstantPattern
// NOTE: quarantined sub-case: constant patterns on BOXED subjects
// (`object answer = 42; answer is 42`) translate to `answer == 42` and fail
// gsc with GS0129 "Binary operator '==' is not defined for types 'object' and
// 'int32'" (same for object/bool). Typed subjects are kept below.

package Corpus.Grid04.Constructs

import System

shared class ConstantPatternFixture {
    func Run() {
        let answer = 42
        let isFortyTwo = answer == 42
        let isFortyOne = answer == 41
        Console.WriteLine("ConstantPattern: 42 is 42 = $isFortyTwo")
        Console.WriteLine("ConstantPattern: 42 is 41 = $isFortyOne")
        let missing object? = nil
        let isNull = missing == nil
        Console.WriteLine("ConstantPattern: null is null = $isNull")
        let flag = true
        let isTrue = flag == true
        Console.WriteLine("ConstantPattern: flag is true = $isTrue")
        let greeting = "hello"
        let isHello = greeting == "hello"
        Console.WriteLine("ConstantPattern: greeting is \"hello\" = $isHello")
    }
}
