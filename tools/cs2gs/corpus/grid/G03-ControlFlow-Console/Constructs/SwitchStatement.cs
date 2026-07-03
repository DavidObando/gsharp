// inventory: SwitchStatement
using System;

namespace Corpus.Grid03.Constructs
{
    public static class SwitchStatementFixture
    {
        public static void Run()
        {
            for (int day = 1; day <= 8; day++)
            {
                string kind;
                switch (day)
                {
                    case 6:
                    case 7:
                        kind = "weekend";
                        break;
                    case 8:
                        kind = "invalid";
                        break;
                    default:
                        kind = "weekday";
                        break;
                }

                Console.WriteLine($"SwitchStatement: day {day} is {kind}");
            }

            string[] colors = { "red", "green", "plaid" };
            foreach (string color in colors)
            {
                switch (color)
                {
                    case "red":
                        Console.WriteLine("SwitchStatement: red means stop");
                        break;
                    case "green":
                        Console.WriteLine("SwitchStatement: green means go");
                        break;
                    default:
                        Console.WriteLine($"SwitchStatement: unknown color {color}");
                        break;
                }
            }
        }
    }
}
