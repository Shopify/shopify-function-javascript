export type ShopifyFunction<Input extends {}, Output extends {}> = (
  input: Input
) => Output;

interface Javy {
  JSON: {
    fromStdin(): any;
    toStdout(val: any);
  }
}

declare global {
  const Javy: Javy;
}

export default function <I extends {}, O extends {}>(userfunction: ShopifyFunction<I, O>) {
  const input_obj = Javy.JSON.fromStdin();
  const output_obj = userfunction(input_obj);
  Javy.JSON.toStdout(output_obj)
}
