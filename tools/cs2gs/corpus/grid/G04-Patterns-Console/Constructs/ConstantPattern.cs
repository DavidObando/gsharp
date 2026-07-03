// inventory: ConstantPattern
// NOTE: quarantined sub-case: constant patterns on BOXED subjects
// (`object answer = 42; answer is 42`) translate to `answer == 42` and fail
// gsc with GS0129 "Binary operator '==' is not defined for types 'object' and
// 'int32'" (same for object/bool). Typed subjects are kept below.
using System;

namespace Corpus.Grid04.Constructs
{
    public static class ConstantPatternFixture
    {
        public static void Run()
        {
            int answer = 42;
            bool isFortyTwo = answer is 42;
            bool isFortyOne = answer is 41;
            Console.WriteLine($"ConstantPattern: 42 is 42 = {isFortyTwo}");
            Console.WriteLine($"ConstantPattern: 42 is 41 = {isFortyOne}");

            object? missing = null;
            bool isNull = missing is null;
            Console.WriteLine($"ConstantPattern: null is null = {isNull}");

            bool flag = true;
            bool isTrue = flag is true;
            Console.WriteLine($"ConstantPattern: flag is true = {isTrue}");

            string greeting = "hello";
            bool isHello = greeting is "hello";
            Console.WriteLine($"ConstantPattern: greeting is \"hello\" = {isHello}");
        }
    }
}
