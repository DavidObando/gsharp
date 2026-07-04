// inventory: FieldExpression — C#14 `field` contextual keyword in property accessors:
// custom-set + auto-get sharing one field, get-with-`??=` + auto-set, both-custom,
// and a property initializer seeding the synthesized backing field.
using System;

namespace Corpus.Grid07
{
    public class ClampedGauge
    {
        // Custom set (clamps via `field`), auto get sharing the same backing field.
        public int Level
        {
            get => field;
            set => field = value < 0 ? 0 : value;
        }
    }

    public class ClampedGaugeWithInit
    {
        // Initializer seeds the compiler-synthesized backing field, not just the property.
        public int Level { get; set => field = value < 0 ? 0 : value; } = 5;
    }

    public class LazyLabel
    {
        // Get-with-`field` lazy-init (`??=`), auto set writing the same field.
        public string Name { get => field ??= "default"; set; }
    }

    public class LoggedCounter
    {
        private int changeCount;

        // Both accessors custom, both touching `field`.
        public int Count
        {
            get => field;
            set
            {
                field = value;
                changeCount = changeCount + 1;
            }
        }

        public int ChangeCount => changeCount;
    }

    public static class FieldExpressionFixture
    {
        public static void Run()
        {
            ClampedGauge gauge = new ClampedGauge();
            gauge.Level = 12;
            Console.WriteLine("FieldExpression: set=" + gauge.Level.ToString());
            gauge.Level = -4;
            Console.WriteLine("FieldExpression: clamped=" + gauge.Level.ToString());

            LazyLabel label = new LazyLabel();
            Console.WriteLine("FieldExpression: lazy=" + label.Name);
            label.Name = "explicit";
            Console.WriteLine("FieldExpression: overwritten=" + label.Name);

            LoggedCounter counter = new LoggedCounter();
            counter.Count = 1;
            counter.Count = 2;
            Console.WriteLine("FieldExpression: counter=" + counter.Count.ToString());
            Console.WriteLine("FieldExpression: changes=" + counter.ChangeCount.ToString());

            ClampedGaugeWithInit initGauge = new ClampedGaugeWithInit();
            Console.WriteLine("FieldExpression: init=" + initGauge.Level.ToString());
            initGauge.Level = -1;
            Console.WriteLine("FieldExpression: initClamped=" + initGauge.Level.ToString());
        }
    }
}
