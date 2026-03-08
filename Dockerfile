FROM python:3.11.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY porpulsion/ porpulsion/
COPY templates/ templates/
COPY static/ static/
COPY charts/porpulsion/files/schema.yaml charts/porpulsion/files/schema.yaml

RUN useradd -m -u 1000 porpulsion
USER porpulsion

CMD ["python", "-m", "porpulsion.agent"]
