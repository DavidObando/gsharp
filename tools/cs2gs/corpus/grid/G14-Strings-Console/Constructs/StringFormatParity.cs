// inventory: InvocationExpression
using System;

namespace Corpus.Grid14
{
    public static class StringFormatParityFixture
    {
        public static void Run()
        {
            int id = 7;
            string name = "Grace";
            string viaFormat = string.Format("{0}-{1,4}-{2:D3}", name, id, id);
            string viaInterp = $"{name}-{id,4}-{id:D3}";
            Console.WriteLine($"StringFormatParity: format={viaFormat}");
            Console.WriteLine($"StringFormatParity: interp={viaInterp}");
            Console.WriteLine($"StringFormatParity: equal={viaFormat == viaInterp}");
        }
    }
}
